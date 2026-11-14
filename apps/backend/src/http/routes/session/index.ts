import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { subscribeSessionEvents } from '@/modules/chat';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('SessionRoute');

/** SSE 保活心跳间隔（与 automation/channels 一致）。 */
const SSE_PING_MS = 25_000;

/**
 * 会话运行事件路由。
 *
 * 后台任务完成唤醒、自驱循环推进都发生在没有 HTTP 请求的情况下，前端靠这条 SSE 感知：
 * 侧栏上浮、当前会话重载、Job 完成 toast、Goal 状态更新。
 */
export function createSessionRouter(): Hono {
    const router = new Hono();

    /** GET /api/session/events — SSE：轮次起止 / 后台投递 / Job / Goal 状态。 */
    router.get('/api/session/events', (c) => {
        return streamSSE(c, async (stream) => {
            const unsubscribe = subscribeSessionEvents((event) => {
                void stream.writeSSE({ event: 'session', data: JSON.stringify(event) });
            });
            stream.onAbort(() => unsubscribe());
            log.info('会话事件 SSE 已连接');
            try {
                while (!c.req.raw.signal.aborted) {
                    await stream.sleep(SSE_PING_MS);
                    await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
                }
            } finally {
                unsubscribe();
            }
        });
    });

    return router;
}
