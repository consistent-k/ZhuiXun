import type { Context } from 'hono';

import { isProd } from '@/config/runtime';
import type { ApiResponse } from '@/config/types';
import { createLogger, getLogger, getRequestId } from '@/platform/logging/index';

/**
 * 统一错误响应体。
 *
 * 背景：此前流式接口把真实异常吞成一句 "An error occurred."，
 * API Key 写错、模型不存在、网络不通在前端看起来完全一样，无法排障。
 *
 * - 开发环境：透传真实错误原因
 * - 生产环境：只返回 requestId，完整堆栈留在服务端日志，避免泄露内部细节
 *
 * requestId 复用请求作用域（httpLogger 生成的同一个），保证前端拿到的 id 能在
 * 服务端日志里检索到完整堆栈；无请求上下文时（极少）才临时生成一个。
 */
export function errorPayload(err: unknown, code = 500): ApiResponse {
    const contextId = getRequestId();
    const requestId = contextId ?? crypto.randomUUID();
    const log = contextId ? getLogger('Error') : createLogger('Error').child({ requestId });
    log.error('请求处理异常', { err });

    const detail = err instanceof Error ? err.message : String(err);
    return {
        code,
        message: isProd() ? `服务器内部错误（requestId: ${requestId}）` : detail
    };
}

export async function errorHandler(err: Error, c: Context) {
    return c.json(errorPayload(err), 500);
}

export async function notFoundHandler(c: Context) {
    const response: ApiResponse = {
        code: 404,
        message: 'Not found'
    };

    return c.json(response, 404);
}
