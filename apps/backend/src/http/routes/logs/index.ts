import fsp from 'node:fs/promises';

import { Hono } from 'hono';

import type { LogLevel } from '@/platform/logging/levels';
import { currentLogFilePath, fileLoggingEnabled, readRecentLogs } from '@/platform/logging/sinks/file';

/**
 * 日志查看 REST：供设置页「日志」面板查看近期后端日志、按级别过滤、导出。
 * 响应统一 `{ code, data, message }`，成功码 0。日志已在写入侧脱敏。
 */

const VALID_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export function createLogsRouter() {
    const router = new Hono();

    // 查询近期日志：?level=&limit=&since=（最新优先）
    router.get('/api/logs', async (c) => {
        const levelRaw = c.req.query('level');
        const level = levelRaw && (VALID_LEVELS as string[]).includes(levelRaw) ? (levelRaw as LogLevel) : undefined;
        const limitRaw = Number(c.req.query('limit'));
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
        const sinceRaw = Number(c.req.query('since'));
        const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;

        const records = await readRecentLogs({ level, limit, since });
        return c.json({ code: 0, data: { enabled: fileLoggingEnabled(), records } });
    });

    // 导出当天日志文件（原始 NDJSON）
    router.get('/api/logs/export', async (c) => {
        const file = currentLogFilePath();
        let content: string;
        try {
            content = await fsp.readFile(file, 'utf8');
        } catch {
            return c.json({ code: 404, message: '暂无日志文件' }, 404);
        }
        c.header('Content-Type', 'application/x-ndjson');
        c.header('Content-Disposition', `attachment; filename="${file.split('/').pop()}"`);
        return c.body(content);
    });

    return router;
}
