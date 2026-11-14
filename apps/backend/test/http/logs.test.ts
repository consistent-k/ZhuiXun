import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/http/middleware/error-handler';
import { createLogsRouter } from '@/http/routes/logs';

const logs = vi.hoisted(() => ({ read: vi.fn(), path: vi.fn(), enabled: vi.fn() }));
vi.mock('@/platform/logging/sinks/file', () => ({
    readRecentLogs: logs.read,
    currentLogFilePath: logs.path,
    fileLoggingEnabled: logs.enabled,
    writeToFile: vi.fn()
}));
const app = new Hono();
app.route('/', createLogsRouter());
app.onError(errorHandler);
let dir: string;
beforeEach(async () => {
    vi.resetAllMocks();
    dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'http-logs-'));
    logs.read.mockResolvedValue([{ level: 'info', message: 'test' }]);
    logs.enabled.mockReturnValue(true);
    logs.path.mockReturnValue(path.join(dir, 'today.log'));
});
afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('logs real HTTP router', () => {
    it('validates optional query values and returns enabled state plus records', async () => {
        for (const [query, expected] of [
            ['', { level: undefined, limit: undefined, since: undefined }],
            ['?level=warn&limit=10&since=123', { level: 'warn', limit: 10, since: 123 }],
            ['?level=bad&limit=-1&since=NaN', { level: undefined, limit: undefined, since: undefined }],
            ['?limit=Infinity&since=-1', { level: undefined, limit: undefined, since: undefined }]
        ] as const) {
            const response = await app.request(`/api/logs${query}`);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                code: 0,
                data: { enabled: true, records: [{ level: 'info', message: 'test' }] }
            });
            expect(logs.read).toHaveBeenLastCalledWith(expected);
        }
        logs.read.mockRejectedValueOnce(new Error('read failed'));
        const failed = await app.request('/api/logs');
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({ code: 500, message: 'read failed' });
    });
    it('exports raw NDJSON with attachment headers or missing-file envelope', async () => {
        logs.path.mockReturnValueOnce(path.join(dir, 'missing.log'));
        const missing = await app.request('/api/logs/export');
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ code: 404, message: '暂无日志文件' });
        const raw = '{"level":"info","message":"test"}\n';
        await fs.writeFile(path.join(dir, 'today.log'), raw);
        const response = await app.request('/api/logs/export');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/x-ndjson');
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="today.log"');
        expect(await response.text()).toBe(raw);
    });
});
