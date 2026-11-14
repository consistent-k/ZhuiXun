/**
 * 文件 sink。
 *
 * 落盘为 NDJSON 到 ~/.zhuixun/logs/backend-YYYY-MM-DD.log（与 memory/sessions 同根，
 * 用 os.homedir() 规避只读 resources 与 __dirname 在 dev/打包两形态含义不同的坑）。
 *
 * 写入串行化：复用 shell-tools 审计日志的 promise 链思路，保证多行不交错、
 * 且任何写盘失败只告警不冒泡（日志失败绝不能影响业务）。
 *
 * 轮转：单文件超过 LOG_MAX_FILE_MB 时把当前文件重命名为带时间戳的备份再起新文件；
 * 保留：目录初始化时清理超过 LOG_RETENTION_DAYS 的历史文件（按 mtime）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import dayjs from 'dayjs';

import { logDir, logMaxBytes, logRetentionDays, logToFile } from '@/config/logging';
import { isEnabled, type LogLevel } from '@/platform/logging/levels';
import type { LogRecord } from '@/platform/logging/logger';
import { currentDate } from '@/platform/logging/time';

const LOG_DIR = logDir();
const MAX_BYTES = logMaxBytes();
const RETENTION_DAYS = logRetentionDays();
const ENABLED = logToFile();

export function fileLoggingEnabled(): boolean {
    return ENABLED;
}

let chain: Promise<void> = Promise.resolve();
let dirReady: Promise<void> | undefined;
let openDate = '';
let openSize = 0;

function today(): string {
    return currentDate();
}

function currentFile(date: string): string {
    return path.join(LOG_DIR, `backend-${date}.log`);
}

async function ensureDir(): Promise<void> {
    dirReady ??= fsp.mkdir(LOG_DIR, { recursive: true }).then(() => {
        void cleanup();
    });
    await dirReady;
}

async function sizeOf(file: string): Promise<number> {
    try {
        const stat = await fsp.stat(file);
        return stat.size;
    } catch {
        return 0;
    }
}

async function rotate(file: string): Promise<void> {
    try {
        await fsp.rename(file, `${file}.${Date.now()}`);
    } catch {
        // 备份失败就继续往原文件追加，不阻断日志
    }
}

async function cleanup(): Promise<void> {
    try {
        const entries = await fsp.readdir(LOG_DIR);
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        await Promise.all(
            entries
                .filter((name) => name.startsWith('backend-'))
                .map(async (name) => {
                    const full = path.join(LOG_DIR, name);
                    try {
                        const stat = await fsp.stat(full);
                        if (stat.mtimeMs < cutoff) await fsp.unlink(full);
                    } catch {
                        // 单个文件清理失败忽略
                    }
                })
        );
    } catch {
        // 目录读取失败忽略（下次写入会重试 ensureDir）
    }
}

export function writeToFile(record: LogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    chain = chain
        .then(async () => {
            await ensureDir();
            const date = today();
            const file = currentFile(date);
            if (date !== openDate) {
                openDate = date;
                openSize = await sizeOf(file);
            }
            const bytes = Buffer.byteLength(line);
            if (openSize + bytes > MAX_BYTES) {
                await rotate(file);
                openSize = 0;
            }
            await fsp.appendFile(file, line, 'utf8');
            openSize += bytes;
        })
        .catch((error: unknown) => {
            console.warn('[Logger] 日志写盘失败:', error instanceof Error ? error.message : error);
        });
}

/** 等待写入队列排空——进程退出前调用，避免丢尾部日志。 */
export function flushLogs(): Promise<void> {
    return chain;
}

/** 日志目录（供导出入口定位文件）。 */
export function logsDirectory(): string {
    return LOG_DIR;
}

/** 当前活动日志文件路径（当天）。 */
export function currentLogFilePath(): string {
    return currentFile(today());
}

export interface ReadLogsOptions {
    /** 返回条数上限（最新优先），默认 200，封顶 2000 */
    limit?: number;
    /** 最低级别（含）过滤，如 'warn' 只看 warn/error */
    level?: LogLevel;
    /** 仅返回该毫秒时间戳之后的记录 */
    since?: number;
}

/**
 * 读取最近的日志记录（最新优先）。按 mtime 倒序遍历日志文件，从文件尾部向前取，
 * 直到满足 limit。供桌面端「日志」面板查看。日志目录不存在 / 读失败返回空数组。
 */
export async function readRecentLogs(options: ReadLogsOptions = {}): Promise<LogRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000);
    let names: string[];
    try {
        names = (await fsp.readdir(LOG_DIR)).filter((n) => n.startsWith('backend-'));
    } catch {
        return [];
    }
    // 按 mtime 倒序：活动文件与最近轮转文件在前
    const withMtime = await Promise.all(
        names.map(async (name) => {
            try {
                const stat = await fsp.stat(path.join(LOG_DIR, name));
                return { name, mtime: stat.mtimeMs };
            } catch {
                return { name, mtime: 0 };
            }
        })
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const out: LogRecord[] = [];
    for (const { name } of withMtime) {
        if (out.length >= limit) break;
        let content: string;
        try {
            content = await fsp.readFile(path.join(LOG_DIR, name), 'utf8');
        } catch {
            continue;
        }
        const lines = content.split('\n');
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
                const rec = JSON.parse(line) as LogRecord;
                if (options.level && !isEnabled(options.level, rec.level)) continue;
                if (options.since && dayjs(rec.ts).valueOf() < options.since) continue;
                out.push(rec);
            } catch {
                /* 跳过损坏行 */
            }
        }
    }
    return out;
}
