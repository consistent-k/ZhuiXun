/**
 * 统一 logger 核心。
 *
 * - Logger 持有 bindings（module / requestId 等），child() 派生出继承并追加 bindings 的子 logger。
 * - 每条日志：级别过滤 → 附加字段脱敏 → 组装记录 → 分发到 console / file 两个 sink。
 * - 级别阈值在模块加载时解析一次（bootstrap-settings 已在 index.ts 首行执行，此时 env 就绪）。
 */
import { isEnabled, resolveLevel, type LogLevel } from './levels';
import { redact } from './redact';
import { writeConsole } from './sinks/console';
import { fileLoggingEnabled, writeToFile } from './sinks/file';
import { nowTimestamp } from './time';

export interface LogFields {
    [key: string]: unknown;
}

export interface LogRecord {
    ts: string;
    level: LogLevel;
    module?: string;
    requestId?: string;
    msg: string;
    [key: string]: unknown;
}

export interface Logger {
    error(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    info(msg: string, fields?: LogFields): void;
    debug(msg: string, fields?: LogFields): void;
    /** 派生子 logger，继承并叠加 bindings（如追加 module / requestId）。 */
    child(bindings: LogFields): Logger;
}

const currentLevel = resolveLevel();

function dispatch(record: LogRecord): void {
    if (process.env.ZHUIXUN_LOG_CONSOLE !== '0') writeConsole(record);
    if (fileLoggingEnabled()) writeToFile(record);
}

class LoggerImpl implements Logger {
    constructor(private readonly bindings: LogFields) {}

    private emit(level: LogLevel, msg: string, fields?: LogFields): void {
        if (!isEnabled(currentLevel, level)) return;
        const safeFields = fields ? (redact(fields) as LogFields) : undefined;
        const record: LogRecord = {
            ts: nowTimestamp(),
            level,
            ...this.bindings,
            msg,
            ...(safeFields ?? {})
        };
        dispatch(record);
    }

    error(msg: string, fields?: LogFields): void {
        this.emit('error', msg, fields);
    }
    warn(msg: string, fields?: LogFields): void {
        this.emit('warn', msg, fields);
    }
    info(msg: string, fields?: LogFields): void {
        this.emit('info', msg, fields);
    }
    debug(msg: string, fields?: LogFields): void {
        this.emit('debug', msg, fields);
    }

    child(bindings: LogFields): Logger {
        return new LoggerImpl({ ...this.bindings, ...bindings });
    }
}

/** 根 logger（无 bindings）。业务侧一般用 createLogger / getLogger 派生。 */
export const rootLogger: Logger = new LoggerImpl({});

/** 创建带模块 tag 的 logger（无请求上下文，用于启动期 / 后台任务）。 */
export function createLogger(module: string): Logger {
    return rootLogger.child({ module });
}
