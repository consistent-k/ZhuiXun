/**
 * 控制台 sink。
 * - LOG_FORMAT=pretty（dev 默认）：彩色单行，人类可读；仅在 TTY 下上色。
 * - LOG_FORMAT=json（prod 默认）：单行 NDJSON，便于从终端启动后端时机读/采集。
 * warn/error 走 stderr，其余走 stdout。
 */
import { logFormat } from '@/config/logging';
import type { LogRecord } from '@/platform/logging/logger';

const FORMAT = logFormat();
const USE_COLOR = FORMAT === 'pretty' && process.stdout.isTTY;

const COLORS: Record<string, string> = {
    error: '\x1b[31m',
    warn: '\x1b[33m',
    info: '\x1b[36m',
    debug: '\x1b[90m'
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const RESERVED = new Set(['ts', 'level', 'module', 'requestId', 'msg']);

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return '[unserializable]';
    }
}

export function writeConsole(record: LogRecord): void {
    const toStderr = record.level === 'error' || record.level === 'warn';
    const sink = toStderr ? console.error : console.log;

    if (FORMAT === 'json') {
        sink(safeStringify(record));
        return;
    }

    const time = record.ts.slice(11, 23); // HH:MM:SS.mmm
    const tag = record.module ? `[${record.module}]` : '';
    const rid = record.requestId ? ` ${record.requestId.slice(0, 8)}` : '';

    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (!RESERVED.has(key)) extra[key] = value;
    }
    const extraStr = Object.keys(extra).length > 0 ? ` ${safeStringify(extra)}` : '';

    const level = record.level.toUpperCase().padEnd(5);
    const paint = (text: string, code: string) => (USE_COLOR ? `${code}${text}${RESET}` : text);

    sink(
        `${paint(time, DIM)} ${paint(level, COLORS[record.level])} ${paint(`${tag}${rid}`, DIM)} ${record.msg}${extraStr}`
    );
}
