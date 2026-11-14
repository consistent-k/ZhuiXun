/**
 * logging 模块对外出口。
 *
 * 用法：
 * - 启动 / 后台：`const log = createLogger('MCP')`
 * - 请求路径深层：`getLogger('Chat')`——有请求上下文自动带 requestId，否则退回模块 logger。
 *   （在流式回调里请在 handler 内先 `const log = getLogger('Chat')` 捕获，body 消费可能已脱离 ALS 作用域。）
 */
import { getRequestContext } from './context';
import { createLogger, rootLogger, type Logger } from './logger';

export { rootLogger, createLogger };
export type { Logger, LogFields, LogRecord } from './logger';
export { runWithRequest, getRequestContext, getRequestId, type RequestContext } from './context';
export { flushLogs } from './sinks/file';

/** 优先返回请求级 logger（带 requestId）+ 模块 tag；无请求上下文时返回模块 logger。 */
export function getLogger(module: string): Logger {
    const context = getRequestContext();
    return context ? context.logger.child({ module }) : createLogger(module);
}
