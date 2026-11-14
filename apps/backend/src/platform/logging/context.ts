/**
 * 请求作用域上下文。
 *
 * 用 AsyncLocalStorage 承载 requestId + 请求级 child logger，让深层模块
 * （runner / mcp / tools）无需在函数签名里透传 logger，就能带上同一 requestId。
 * 启动期 / 后台任务没有上下文，getLogger 会退回模块级 logger（见 ./index.ts）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from './logger';

export interface RequestContext {
    requestId: string;
    logger: Logger;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** 在给定请求上下文中执行 fn；fn 内（含其 await 链、流式回调）均可读到该上下文。 */
export function runWithRequest<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
    return storage.getStore();
}

export function getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
}
