import { Hono } from 'hono';

import { CompactError, compactConversation } from '@/modules/chat';
import { getCheckpointStore } from '@/modules/conversations';
import {
    getConversationStore,
    isValidConversationId,
    QuestionValidationError,
    type ConversationUpsert,
    type StoredMessage
} from '@/modules/conversations';
import { listPersonas } from '@/modules/persona';

/**
 * 会话管理 REST：供前端会话仓储读写。
 * 会话真源在后端 `~/.zhuixun/sessions/`（每会话一文件 + index.json）。
 * 响应统一 `{ code, data, message }`，成功码 0。
 */

/** 边界层最必要的形状校验：畸形请求体尽早拒绝，避免脏数据落盘。parts 透明存储不解析 */
function parseUpsert(body: unknown): ConversationUpsert | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (typeof b.title !== 'string') return null;
    if (!Array.isArray(b.messages)) return null;

    const messages: StoredMessage[] = [];
    for (const raw of b.messages) {
        if (!raw || typeof raw !== 'object') return null;
        const m = raw as Record<string, unknown>;
        if (typeof m.id !== 'string') return null;
        if (m.role !== 'user' && m.role !== 'assistant') return null;
        if (typeof m.content !== 'string') return null;
        const msg: StoredMessage = { id: m.id, role: m.role, content: m.content };
        if (typeof m.timestamp === 'number') msg.timestamp = m.timestamp;
        if (Array.isArray(m.parts)) msg.parts = m.parts as unknown[];
        // 透传 metadata（含本轮最后一步 usage 与上下文压缩标记 compaction）：前端写穿时若丢弃，
        // 刷新/切回会话后 token 用量与「上下文已压缩」分隔条都会消失。
        if (m.metadata !== undefined) msg.metadata = m.metadata;
        messages.push(msg);
    }

    const createdAt = typeof b.createdAt === 'number' ? b.createdAt : Date.now();
    const projectId = typeof b.projectId === 'string' && b.projectId ? b.projectId : undefined;
    const personaId = typeof b.personaId === 'string' && b.personaId ? b.personaId : undefined;
    return { title: b.title, projectId, personaId, createdAt, messages };
}

export function createConversationsRouter() {
    const router = new Hono();
    router.onError((error, c) => {
        if (error instanceof QuestionValidationError) {
            return c.json({ code: error.status, message: error.message }, error.status);
        }
        throw error;
    });

    router.get('/api/conversations', async (c) => {
        // 可选 ?projectId= 过滤：传具体 id 返回该项目会话，传 __ungrouped__ 返回未分组，不传返回全部
        const raw = c.req.query('projectId');
        let filter: string | null | undefined;
        if (raw === undefined) filter = undefined;
        else if (raw === '' || raw === '__ungrouped__') filter = null;
        else filter = raw;
        const data = await getConversationStore().list(filter);
        return c.json({ code: 0, data });
    });

    // 变更审计日志（append-only）。必须注册在 /:id 之前，避免被参数路由捕获成 id='history'
    router.get('/api/conversations/history', async (c) => {
        const data = await getConversationStore().readHistory();
        return c.json({ code: 0, data });
    });

    // 导出全部会话（JSON 包）。静态子路径，必须在 /:id 之前注册。
    router.get('/api/conversations/export', async (c) => {
        const data = await getConversationStore().exportAll();
        return c.json({ code: 0, data });
    });

    // 导入会话（JSON 包或会话数组）。id 冲突自动重映射为新 uuid。
    router.post('/api/conversations/import', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { conversations?: unknown } | unknown[] | null;
        const conversations = Array.isArray(body) ? body : (body?.conversations ?? null);
        if (!Array.isArray(conversations)) {
            return c.json({ code: 400, message: '导入内容格式不正确' }, 400);
        }
        const data = await getConversationStore().importMany(conversations);
        return c.json({ code: 0, data });
    });

    router.get('/api/conversations/:id', async (c) => {
        const conv = await getConversationStore().get(c.req.param('id'));
        if (!conv) return c.json({ code: 404, message: '会话不存在' }, 404);
        return c.json({ code: 0, data: conv });
    });

    // 导出单个会话全量
    router.get('/api/conversations/:id/export', async (c) => {
        const conv = await getConversationStore().exportOne(c.req.param('id'));
        if (!conv) return c.json({ code: 404, message: '会话不存在' }, 404);
        return c.json({ code: 0, data: conv });
    });

    router.put('/api/conversations/:id', async (c) => {
        const id = c.req.param('id');
        if (!isValidConversationId(id)) {
            return c.json({ code: 400, message: '非法会话 id' }, 400);
        }
        const body = await c.req.json().catch(() => null);
        const upsert = parseUpsert(body);
        if (!upsert) {
            return c.json({ code: 400, message: '请求参数不合法' }, 400);
        }
        const data = await getConversationStore().upsert(id, upsert);
        return c.json({ code: 0, data });
    });

    // 移动会话到项目（轻量，不传 messages）。projectId 为 null 表示移出到未分组。
    // 仅改 projectId 单字段 → 用 PATCH（与全量 upsert 的 PUT /:id 区分）。
    router.patch('/api/conversations/:id/project', async (c) => {
        const id = c.req.param('id');
        if (!isValidConversationId(id)) {
            return c.json({ code: 400, message: '非法会话 id' }, 400);
        }
        const body = (await c.req.json().catch(() => null)) as { projectId?: unknown } | null;
        const rawPid = body?.projectId;
        const projectId = typeof rawPid === 'string' && rawPid ? rawPid : null;
        const data = await getConversationStore().updateProjectId(id, projectId);
        if (!data) return c.json({ code: 404, message: '会话不存在' }, 404);
        return c.json({ code: 0, data });
    });

    // 设置/清除会话级表达风格覆盖。personaId=null 表示回到跟随全局默认。
    router.patch('/api/conversations/:id/persona', async (c) => {
        const id = c.req.param('id');
        if (!isValidConversationId(id)) {
            return c.json({ code: 400, message: '非法会话 id' }, 400);
        }
        const body = (await c.req.json().catch(() => null)) as { personaId?: unknown } | null;
        if (!body || (body.personaId !== null && typeof body.personaId !== 'string')) {
            return c.json({ code: 400, message: '请求参数不合法' }, 400);
        }
        const personaId = typeof body.personaId === 'string' && body.personaId ? body.personaId : null;
        if (personaId && !listPersonas().items.some((item) => item.id === personaId)) {
            return c.json({ code: 400, message: '风格不存在' }, 400);
        }
        const data = await getConversationStore().updatePersonaId(id, personaId);
        if (!data) return c.json({ code: 404, message: '会话不存在' }, 404);
        return c.json({ code: 0, data });
    });

    // 重命名会话（轻量，不传 messages）。手动改名置 titleAuto 锁，使其不被整单写穿覆盖、也不再被首轮 AI 标题覆盖。
    // 仅改 title 单字段 → 用 PATCH（与全量 upsert 的 PUT /:id 区分）。
    router.patch('/api/conversations/:id/title', async (c) => {
        const id = c.req.param('id');
        if (!isValidConversationId(id)) {
            return c.json({ code: 400, message: '非法会话 id' }, 400);
        }
        const body = (await c.req.json().catch(() => null)) as { title?: unknown } | null;
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        if (!title) {
            return c.json({ code: 400, message: '标题不能为空' }, 400);
        }
        const data = await getConversationStore().updateTitle(id, title, { auto: true });
        if (!data) return c.json({ code: 404, message: '会话不存在' }, 404);
        return c.json({ code: 0, data });
    });

    // 回滚到指定用户消息：还原该消息所在用户轮及其后 Write/Edit 触碰的文件，并把对话截断到该消息之前。
    // 先还文件再截消息，返回受影响文件清单（restored/deleted/skipped）与截断后的会话元信息。
    router.post('/api/conversations/:id/rewind', async (c) => {
        const id = c.req.param('id');
        if (!isValidConversationId(id)) {
            return c.json({ code: 400, message: '非法会话 id' }, 400);
        }
        const body = (await c.req.json().catch(() => null)) as { toMessageId?: unknown } | null;
        const toMessageId = typeof body?.toMessageId === 'string' ? body.toMessageId : '';
        if (!toMessageId) {
            return c.json({ code: 400, message: '缺少 toMessageId' }, 400);
        }
        const files = await getCheckpointStore().rewind(id, toMessageId);
        const meta = await getConversationStore().truncateFrom(id, toMessageId);
        if (!meta) return c.json({ code: 404, message: '会话或消息不存在' }, 404);
        return c.json({ code: 0, data: { meta, files } });
    });

    // 手动压缩上下文（/compact）：写检查点供下一轮使用；生成中 409，无可压缩内容返回 changed=false
    router.post('/api/conversations/:id/compact', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { instructions?: unknown } | null;
        const raw = body?.instructions;
        if (raw !== undefined && (typeof raw !== 'string' || raw.length > 2000)) {
            return c.json({ code: 400, message: 'instructions 必须是不超过 2000 字的字符串' }, 400);
        }
        try {
            return c.json({ code: 0, data: await compactConversation(c.req.param('id'), raw) });
        } catch (error) {
            if (error instanceof CompactError)
                return c.json({ code: error.status, message: error.message }, error.status);
            throw error;
        }
    });

    router.delete('/api/conversations/:id', async (c) => {
        const id = c.req.param('id');
        await getConversationStore().delete(id);
        return c.json({ code: 0, data: { id } });
    });

    router.delete('/api/conversations', async (c) => {
        const cleared = await getConversationStore().clear();
        return c.json({ code: 0, data: { cleared } });
    });

    return router;
}
