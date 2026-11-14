import { createUIMessageStreamResponse, UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { Hono } from 'hono';
import { z } from 'zod';

import { errorPayload } from '@/http/middleware/error-handler';
import { fail, notReady, ok } from '@/http/respond';
import {
    canStoreAttachment,
    isAllowedAttachment,
    MAX_FILE_BYTES,
    MAX_IMAGE_BYTES,
    readAttachment,
    saveAttachment
} from '@/modules/chat';
import { ChatTurnError, getResumableStreamStore, runChatTurn, type ChatTurnInput } from '@/modules/chat';
import { isValidConversationId } from '@/modules/conversations';
import type { SkillRegistry } from '@/modules/skills';

// UIMessage 结构较复杂（parts 是多态数组），这里只做边界层最必要的形状校验，
// 完整结构交给 AI SDK 内部处理；目的是在畸形请求体时尽早拒绝，避免难以理解的报错。
const chatRequestSchema = z.object({
    messages: z
        .array(
            z.object({
                id: z.string().optional(),
                role: z.string(),
                parts: z.array(z.record(z.string(), z.unknown())).optional(),
                // 透传消息 metadata（含上一轮最后一步 usage）：上下文自动压缩据此按真实用量判阈，
                // 不声明会被 zod 剥离，导致压缩只能退回字符估算。
                metadata: z.unknown().optional()
            })
        )
        .min(1),
    // 单次覆盖：指定 `providerName/modelName`，服务端按已存 provider 解析出密钥；缺省用激活模型。
    // 不再从请求体接收整份 modelConfig（含明文 apiKey），密钥始终留在后端。
    model: z.string().optional(),
    agentMode: z.enum(['routed', 'progressive']).optional(),
    personaId: z.string().max(80).optional(),
    approvalMode: z.enum(['ask', 'auto-review', 'full-access']).optional(),
    approvalGrant: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    // 会话 id：用于命令审批「仅本次会话」范围的规则匹配、落库与可恢复流。
    sessionId: z.string().optional(),
    // 项目 id：会话所属项目，用于注入项目级指令/知识与技能集。
    projectId: z.string().optional(),
    requestId: z.uuid().optional()
});

/**
 * 对话流式接口。
 *
 * 路由只负责 HTTP：解析请求、调用 `runChatTurn`、把 UI 消息流包成 SSE 响应。
 * 编排（模型/工作区解析、落库、压缩、标题、记忆维护）全部在 `modules/chat/service.ts`。
 *
 * 用 getter 而不是直接传 SkillRegistry，因为 registry 是服务启动时异步初始化的。
 */
export function createChatRouter(getRegistry: () => SkillRegistry | undefined) {
    const chatRouter = new Hono();

    const turns = new Map<string, { requestId?: string; controller: AbortController }>();

    chatRouter.post('/api/chat/:sessionId/cancel', (c) => {
        const turn = turns.get(c.req.param('sessionId'));
        const matches = !!turn?.requestId && turn.requestId === c.req.query('requestId');
        if (matches) turn.controller.abort();
        return ok(c, { cancelled: matches });
    });

    chatRouter.post('/api/chat/stream', async (c) => {
        const registry = getRegistry();
        if (!registry) return notReady(c, '服务尚未就绪（技能注册表未初始化）');

        try {
            const parsed = chatRequestSchema.safeParse(await c.req.json());
            if (!parsed.success) {
                return fail(
                    c,
                    400,
                    `请求参数不合法: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
                );
            }

            const { sessionId, requestId } = parsed.data;
            if (sessionId && turns.has(sessionId)) return fail(c, 409, '会话正在生成，请等待当前轮次结束');
            const controller = new AbortController();
            if (sessionId) turns.set(sessionId, { requestId, controller });
            const release = () => {
                if (sessionId) turns.delete(sessionId);
            };
            let handle;
            try {
                handle = await runChatTurn(parsed.data as ChatTurnInput, registry, controller.signal);
            } catch (error) {
                release();
                throw error;
            }
            // 可恢复流的录制分支继续消费到结束，断线时仍保留当前轮次占用。
            const reader = handle.stream.getReader();
            const stream = new ReadableStream({
                async pull(writer) {
                    try {
                        const chunk = await reader.read();
                        if (chunk.done) {
                            release();
                            writer.close();
                        } else writer.enqueue(chunk.value);
                    } catch (error) {
                        release();
                        writer.error(error);
                    }
                },
                async cancel(reason) {
                    try {
                        await reader.cancel(reason);
                    } finally {
                        release();
                    }
                }
            });
            return createUIMessageStreamResponse({
                stream,
                // 旁路录制到可恢复流缓冲，供刷新/重连回放（无 sessionId 则不支持恢复）
                consumeSseStream: handle.canResume
                    ? ({ stream: sse }) => getResumableStreamStore().record(handle.chatId, sse)
                    : undefined
            });
        } catch (error) {
            if (error instanceof ChatTurnError) return fail(c, error.status, error.message);
            return c.json(errorPayload(error), 500);
        }
    });

    // 重连端点：AI SDK 的 reconnectToStream 默认发 GET `${api}/${chatId}/stream`。
    // 命中进行中的（或刚结束 TTL 内的）流则回放 SSE，否则 204（前端 resumeStream 静默结束）。
    chatRouter.get('/api/chat/stream/:chatId/stream', (c) => {
        const chatId = c.req.param('chatId');
        if (!isValidConversationId(chatId)) return c.body(null, 204);
        const stream = getResumableStreamStore().reconnect(chatId);
        if (!stream) return c.body(null, 204);
        return new Response(stream, { status: 200, headers: UI_MESSAGE_STREAM_HEADERS });
    });

    // 当前进行中的会话 id：供前端刷新后在侧栏显示「生成中」（未打开的会话也能标注）
    chatRouter.get('/api/chat/active', (c) => {
        return ok(c, { ids: getResumableStreamStore().getActiveIds() });
    });

    // 对话附件上传（multipart：file + sessionId）。落 <sessionsDir>/<sid>/uploads/，返回引用信息。
    // 密钥/审批与此无关；仅做类型与大小白名单校验（图片/PDF/表格/Word/文本·代码）。
    chatRouter.post('/api/chat/upload', async (c) => {
        let file: unknown;
        let sessionId: unknown;
        try {
            const body = await c.req.parseBody();
            file = body['file'];
            sessionId = body['sessionId'];
        } catch {
            return fail(c, 400, '请求体解析失败（需 multipart/form-data，字段 file + sessionId）');
        }
        if (!file || typeof (file as File).arrayBuffer !== 'function') {
            return fail(c, 400, '缺少上传文件（字段名 file）');
        }
        if (typeof sessionId !== 'string' || !canStoreAttachment(sessionId)) {
            return fail(c, 400, '缺少或非法的 sessionId');
        }
        const f = file as File;
        const mediaType = (f.type || '').toLowerCase();
        const filename = f.name || 'file';
        // 旧版 .xls 是二进制格式，本服务端只能解 zip（xlsx），直接拒绝并引导转存
        if (/\.xls$/i.test(filename)) {
            return fail(c, 400, '不支持旧版 .xls，请另存为 .xlsx 或 .csv 后上传');
        }
        if (!isAllowedAttachment(mediaType, filename)) {
            return fail(
                c,
                400,
                `不支持的文件类型：${f.type || '未知'}（支持图片、PDF、表格 CSV/Excel、Word、纯文本与代码文件）`
            );
        }
        const data = new Uint8Array(await f.arrayBuffer());
        const limit = mediaType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        if (data.byteLength > limit) {
            return fail(c, 400, `文件过大（上限 ${Math.floor(limit / 1024 / 1024)}MB）`);
        }
        try {
            const result = await saveAttachment(sessionId, { data, filename, mediaType });
            return ok(c, result);
        } catch (err) {
            return c.json(errorPayload(err), 500);
        }
    });

    // 对话附件读取：供消息气泡内 `<img src>` 预览与下载（Content-Type 取自元信息）。
    // 免 token（原生资源标签带不了自定义头），仍受 Origin 白名单 + 127.0.0.1 + 会话 id 校验保护。
    chatRouter.get('/api/chat/files/:sid/:id', async (c) => {
        const file = await readAttachment(c.req.param('sid'), c.req.param('id'));
        if (!file) return c.body(null, 404);
        c.header('Content-Type', file.meta.mediaType);
        c.header('Content-Disposition', `inline; filename="${encodeURIComponent(file.meta.filename)}"`);
        c.header('Cache-Control', 'private, max-age=3600');
        return c.body(file.data as unknown as ArrayBuffer);
    });

    return chatRouter;
}
