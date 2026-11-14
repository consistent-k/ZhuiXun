/**
 * 日志 sink 相关配置（目录 / 轮转 / 保留 / 落盘开关 / 控制台形态）。
 * 日志级别阈值仍由 logging/levels.ts 负责（那里持有 LOG_LEVELS 常量），
 * 但其 env 读取也已改走 config/env + config/runtime。
 *
 * 本模块只依赖 config 内的叶子模块（env/runtime/paths），不反向 import logging，
 * 避免与「logging 依赖 paths 解析日志目录」形成循环。
 */
import { bool, num, optional } from './env';
import { paths } from './paths';
import { isProd } from './runtime';

/** 日志目录：~/.zhuixun/logs（LOG_DIR 可覆盖）。 */
export function logDir(): string {
    return paths.logsDir();
}

/** 单日志文件大小上限（字节）。LOG_MAX_FILE_MB 覆盖，默认 10MB。 */
export function logMaxBytes(): number {
    return num('LOG_MAX_FILE_MB', 10, { positive: true }) * 1024 * 1024;
}

/** 日志保留天数。LOG_RETENTION_DAYS 覆盖，默认 7。 */
export function logRetentionDays(): number {
    return num('LOG_RETENTION_DAYS', 7, { positive: true });
}

/** 是否落盘到文件。LOG_TO_FILE 显式覆盖，否则 dev 仅 console / prod 落盘。 */
export function logToFile(): boolean {
    return bool('LOG_TO_FILE', isProd());
}

/** 控制台输出形态。LOG_FORMAT 覆盖（pretty|json），否则 dev:pretty / prod:json。 */
export function logFormat(): 'pretty' | 'json' {
    const raw = optional('LOG_FORMAT')?.toLowerCase();
    if (raw === 'pretty' || raw === 'json') return raw;
    return isProd() ? 'json' : 'pretty';
}
