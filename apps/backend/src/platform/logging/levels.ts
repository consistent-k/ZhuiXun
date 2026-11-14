/**
 * 日志级别定义与阈值解析。
 *
 * 级别从严重到细节：error > warn > info > debug。
 * 阈值由 LOG_LEVEL 控制，默认 dev=debug / prod=info。
 */

import { optional } from '@/config/env';
import { isProd } from '@/config/runtime';

export const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

/** 解析当前输出阈值；非法值回退到环境默认。 */
export function resolveLevel(): LogLevel {
    const raw = optional('LOG_LEVEL')?.toLowerCase();
    if (raw && raw in LOG_LEVELS) return raw as LogLevel;
    return isProd() ? 'info' : 'debug';
}

/** target 是否达到当前阈值（数值越小越严重，越应输出）。 */
export function isEnabled(current: LogLevel, target: LogLevel): boolean {
    return LOG_LEVELS[target] <= LOG_LEVELS[current];
}
