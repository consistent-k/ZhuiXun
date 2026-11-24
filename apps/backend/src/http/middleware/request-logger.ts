/**
 * 统一请求日志中间件。
 *
 * 取代 hono 内置 logger()：为每个请求生成（或沿用上游透传的）requestId，
 * 用 runWithRequest 建立请求作用域，使下游所有 handler / onError / errorPayload
 * 都能拿到同一 requestId；请求完成后打一条访问日志，并把 requestId 回写响应头
 * x-request-id，便于前端与服务端日志对齐排障。
 */
import type { Context, Next } from 'hono';

import { rootLogger, runWithRequest } from '@/platform/logging/index';

export async function httpLogger(c: Context, next: Next): Promise<void> {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID();
    const requestLogger = rootLogger.child({ requestId });
    c.header('x-request-id', requestId);

    const start = Date.now();
    await runWithRequest({ requestId, logger: requestLogger }, () => next());
    const durationMs = Date.now() - start;

    const status = c.res.status;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    // 一次性下载能力不能进入日志，避免在有效期内被复用。
    const logPath = c.req.path.startsWith('/workspace-download/') ? '/workspace-download/[redacted]' : c.req.path;
    requestLogger.child({ module: 'HTTP' })[level](`${c.req.method} ${logPath} ${status} ${durationMs}ms`);
}
