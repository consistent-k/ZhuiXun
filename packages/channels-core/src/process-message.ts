/**
 * 通用渠道消息处理管线（所有 provider 共用，零后端依赖，能力经 ChannelContext.runtime 注入）。
 *
 * 追加用户消息 → 发 inbound 事件 → runAgent → 消费 UI message stream：
 *   - 累积纯文本回复
 *   - 工具调用 / 思考开始时发 IM 通知
 *   - 同时把 UI chunk 以 SSE 帧旁路录入可恢复流（前端逐字回放）
 * → 追加 AI 回复 → 发回 IM → 发 reply 事件。
 */
import type { ChannelContext, ChannelOrigin, ProcessMessageParams } from './types';

export async function processMessage(params: ProcessMessageParams, ctx: ChannelContext): Promise<void> {
    const { channelId, channelName, userId, text, transport, abortSignal, filterReply } = params;
    const { runAgent, runtime } = ctx;
    const log = runtime.createLogger('Channel');
    const sessionId = runtime.channelSessionId(channelId, userId);
    const origin: ChannelOrigin = { kind: 'channel', channelId, channelName, imUserId: userId };

    // 先落用户消息 + 发 inbound 事件（前端侧栏据此出现/上浮会话）
    await runtime.appendUserMessage(sessionId, origin, text);
    runtime.emitEvent({ type: 'inbound', channelId, channelName, userId, sessionId, text, ts: Date.now() });

    const history = await runtime.loadHistory(sessionId);
    log.info('渠道消息处理', { channelId, userId, sessionId, historyLen: history.length });

    const stopTyping = await Promise.resolve(transport.startTyping(userId, abortSignal)).catch(() => () => {});

    // 旁路录入可恢复流：best-effort，不影响主流程。用 ref 对象持有 controller，避免 TS 窄化成 null。
    const sseRef: { ctl: ReadableStreamDefaultController<string> | null } = { ctl: null };
    const sse = new ReadableStream<string>({
        start(controller) {
            sseRef.ctl = controller;
        }
    });
    runtime.recordStream(sessionId, sse);

    try {
        const result = await runAgent(history, { sessionId, abortSignal });
        let replyText = '';
        for await (const chunk of result.toUIMessageStream()) {
            try {
                sseRef.ctl?.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
            } catch {
                /* 控制器已关闭：忽略 */
            }
            const type = (chunk as { type?: string }).type;
            if (type === 'text-delta') {
                replyText += (chunk as { delta?: string }).delta ?? '';
            } else if (type === 'tool-input-start') {
                const toolName = (chunk as { toolName?: string }).toolName ?? '工具';
                transport.sendNotification(userId, `正在使用工具：${toolName}`);
            } else if (type === 'reasoning-start') {
                transport.sendNotification(userId, '思考中…');
            }
        }
        try {
            sseRef.ctl?.close();
        } catch {
            /* 已关闭：忽略 */
        }

        const reply = filterReply ? filterReply(replyText) : replyText;
        await runtime.appendAssistantMessage(sessionId, replyText);

        if (!reply.trim()) {
            log.warn('空 AI 回复，跳过发送', { channelId, userId });
            return;
        }
        await transport.sendText(userId, reply);
        runtime.emitEvent({ type: 'reply', channelId, channelName, userId, sessionId, text: reply, ts: Date.now() });
        log.info('渠道回复已发送', { channelId, userId, len: reply.length });
    } catch (err) {
        try {
            sseRef.ctl?.close();
        } catch {
            /* 已关闭：忽略 */
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('渠道消息处理失败', { channelId, userId, err: errMsg });
        runtime.emitEvent({ type: 'error', channelId, channelName, userId, sessionId, text: errMsg, ts: Date.now() });
        try {
            await transport.sendText(
                userId,
                `⚠️ 处理失败：${errMsg.length > 200 ? errMsg.slice(0, 200) + '...' : errMsg}`
            );
        } catch (sendErr) {
            log.error('发送错误提示失败', { channelId, userId, err: String(sendErr) });
        }
    } finally {
        stopTyping();
    }
}

/** 带 AbortSignal 的 sleep（provider 长轮询退避复用）。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
            },
            { once: true }
        );
    });
}
