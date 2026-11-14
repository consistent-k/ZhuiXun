import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogRecord } from '@/platform/logging/logger';
import type * as FileSinkModule from '@/platform/logging/sinks/file';

import { createTempData, type TempData } from '../helpers/temp-data';

type FileSink = typeof FileSinkModule;
let temp: TempData;
let directory: string;
let sink: FileSink | undefined;

beforeEach(async () => {
    vi.resetModules();
    temp = await createTempData('zhuixun-platform-logging-integration-');
    directory = path.join(temp.root, 'logs');
    vi.stubEnv('LOG_DIR', directory);
    vi.stubEnv('LOG_TO_FILE', 'true');
    vi.stubEnv('LOG_FORMAT', 'json');
    vi.stubEnv('LOG_LEVEL', 'debug');
    vi.stubEnv('LOG_MAX_FILE_MB', '10');
    vi.stubEnv('LOG_RETENTION_DAYS', '7');
});

afterEach(async () => {
    await sink?.flushLogs();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await temp.cleanup();
});

async function loadSink(): Promise<FileSink> {
    sink = await import('@/platform/logging/sinks/file');
    return sink;
}

function entry(msg: string, overrides: Partial<LogRecord> = {}): LogRecord {
    return { ts: '2026-01-02T03:04:05.006+08:00', level: 'info', msg, ...overrides };
}

function line(record: LogRecord): string {
    return `${JSON.stringify(record)}\n`;
}

async function writeFixture(name: string, content: string, mtime?: number): Promise<string> {
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, name);
    await fs.writeFile(file, content, 'utf8');
    if (mtime !== undefined) await fs.utimes(file, mtime / 1000, mtime / 1000);
    return file;
}

describe('logging file sink queue and rotation', () => {
    it('serializes concurrent records, flushes all UTF-8 bytes and exposes isolated paths', async () => {
        const file = await loadSink();
        expect(file.fileLoggingEnabled()).toBe(true);
        expect(file.logsDirectory()).toBe(directory);
        expect(file.currentLogFilePath()).toMatch(/backend-\d{4}-\d{2}-\d{2}\.log$/);
        expect(path.dirname(file.currentLogFilePath())).toBe(directory);
        await expect(file.flushLogs()).resolves.toBeUndefined();
        const records = Array.from({ length: 30 }, (_, index) => entry(`中文-${index}`));
        records.forEach(file.writeToFile);
        await file.flushLogs();
        const content = await fs.readFile(file.currentLogFilePath(), 'utf8');
        expect(content).toBe(records.map(line).join(''));
        expect(
            content
                .trim()
                .split('\n')
                .map((value) => JSON.parse(value))
        ).toEqual(records);
    });

    it('reports the disabled switch without creating files on import', async () => {
        vi.stubEnv('LOG_TO_FILE', 'false');
        const file = await loadSink();
        expect(file.fileLoggingEnabled()).toBe(false);
        await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('loads existing file size, allows the exact byte boundary and rotates before the next append', async () => {
        const record = entry('中文');
        const bytes = Buffer.byteLength(line(record));
        vi.stubEnv('LOG_MAX_FILE_MB', String((bytes * 2) / 1024 / 1024));
        const file = await loadSink();
        await writeFixture(path.basename(file.currentLogFilePath()), line(record));
        file.writeToFile(record);
        await file.flushLogs();
        expect((await fs.readdir(directory)).filter((name) => name.startsWith('backend-'))).toHaveLength(1);
        expect(await fs.readFile(file.currentLogFilePath(), 'utf8')).toBe(line(record).repeat(2));
        file.writeToFile(record);
        await file.flushLogs();
        const names = await fs.readdir(directory);
        const backup = names.find((name) => name.startsWith(`${path.basename(file.currentLogFilePath())}.`));
        expect(backup).toBeDefined();
        expect(await fs.readFile(path.join(directory, backup!), 'utf8')).toBe(line(record).repeat(2));
        expect(await fs.readFile(file.currentLogFilePath(), 'utf8')).toBe(line(record));
    });

    it('continues appending when a rotation rename fails', async () => {
        vi.stubEnv('LOG_MAX_FILE_MB', String(1 / 1024 / 1024));
        const file = await loadSink();
        const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('rename denied'));
        file.writeToFile(entry('oversized'));
        await file.flushLogs();
        expect(rename).toHaveBeenCalledOnce();
        expect(await fs.readFile(file.currentLogFilePath(), 'utf8')).toBe(line(entry('oversized')));
    });

    it('starts a new date file at Shanghai midnight and refreshes that file size', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T15:59:59.000Z'));
        const file = await loadSink();
        file.writeToFile(entry('before'));
        await file.flushLogs();
        expect(file.currentLogFilePath()).toBe(path.join(directory, 'backend-2026-01-01.log'));
        vi.setSystemTime(new Date('2026-01-01T16:00:00.000Z'));
        await writeFixture('backend-2026-01-02.log', line(entry('preexisting')));
        file.writeToFile(entry('after'));
        await file.flushLogs();
        expect(file.currentLogFilePath()).toBe(path.join(directory, 'backend-2026-01-02.log'));
        expect(await fs.readFile(path.join(directory, 'backend-2026-01-01.log'), 'utf8')).toBe(line(entry('before')));
        expect(await fs.readFile(file.currentLogFilePath(), 'utf8')).toBe(
            line(entry('preexisting')) + line(entry('after'))
        );
    });

    it('swallows Error and non-Error append failures and recovers the queue', async () => {
        const file = await loadSink();
        const append = vi.spyOn(fs, 'appendFile');
        append.mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce('primitive failure');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        file.writeToFile(entry('lost-1'));
        file.writeToFile(entry('lost-2'));
        file.writeToFile(entry('kept'));
        await expect(file.flushLogs()).resolves.toBeUndefined();
        expect(warn.mock.calls).toEqual([
            ['[Logger] 日志写盘失败:', 'disk full'],
            ['[Logger] 日志写盘失败:', 'primitive failure']
        ]);
        expect(await fs.readFile(file.currentLogFilePath(), 'utf8')).toBe(line(entry('kept')));
    });

    it('does not reject flush when creating the log directory fails', async () => {
        const file = await loadSink();
        vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('mkdir denied'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        file.writeToFile(entry('lost'));
        await expect(file.flushLogs()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledExactlyOnceWith('[Logger] 日志写盘失败:', 'mkdir denied');
    });
});

describe('logging retention cleanup', () => {
    it('removes only expired backend logs, keeping fresh and unrelated files', async () => {
        vi.stubEnv('LOG_RETENTION_DAYS', '2');
        const stale = Date.now() - 3 * 24 * 60 * 60 * 1000;
        await writeFixture('backend-old.log.1', 'old', stale);
        await writeFixture('backend-fresh.log', 'fresh');
        await writeFixture('other-old.log', 'not a backend log', stale);
        const file = await loadSink();
        file.writeToFile(entry('trigger'));
        await file.flushLogs();
        await vi.waitFor(async () => expect(await fs.readdir(directory)).not.toContain('backend-old.log.1'));
        expect(await fs.readdir(directory)).toEqual(expect.arrayContaining(['backend-fresh.log', 'other-old.log']));
    });

    it('ignores per-file stat and unlink failures during cleanup', async () => {
        const stale = Date.now() - 10 * 24 * 60 * 60 * 1000;
        const statFailure = await writeFixture('backend-stat-fails.log', 'old', stale);
        const unlinkFailure = await writeFixture('backend-unlink-fails.log', 'old', stale);
        const originalStat = fs.stat.bind(fs);
        const stat = vi.spyOn(fs, 'stat').mockImplementation((...args: Parameters<typeof fs.stat>) => {
            if (args[0] === statFailure) return Promise.reject(new Error('stat denied'));
            return originalStat(...args);
        });
        const unlink = vi.spyOn(fs, 'unlink').mockRejectedValue(new Error('unlink denied'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const file = await loadSink();
        file.writeToFile(entry('trigger'));
        await file.flushLogs();
        await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith(unlinkFailure));
        expect(stat).toHaveBeenCalledWith(statFailure);
        expect(warn).not.toHaveBeenCalled();
        expect(await fs.readFile(file.currentLogFilePath(), 'utf8')).toBe(line(entry('trigger')));
    });

    it('ignores cleanup directory read failures without interrupting writes', async () => {
        vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('read denied'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const file = await loadSink();
        file.writeToFile(entry('still written'));
        await file.flushLogs();
        expect(warn).not.toHaveBeenCalled();
        expect(await fs.readFile(file.currentLogFilePath(), 'utf8')).toBe(line(entry('still written')));
    });
});

describe('logging recent record reader', () => {
    it('returns empty for missing or unreadable directories', async () => {
        const file = await loadSink();
        await expect(file.readRecentLogs()).resolves.toEqual([]);
        vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('read denied'));
        await expect(file.readRecentLogs()).resolves.toEqual([]);
    });

    it('orders files by mtime, records backwards, skips corrupt/blank/unrelated lines and filters severity/time', async () => {
        const first = entry('first', { level: 'error', ts: '2026-01-01T00:00:00.000+08:00' });
        const second = entry('second', { level: 'warn', ts: '2026-01-02T00:00:00.000+08:00' });
        const third = entry('third', { level: 'info', ts: '2026-01-03T00:00:00.000+08:00' });
        const fourth = entry('fourth', { level: 'debug', ts: '2026-01-04T00:00:00.000+08:00' });
        await writeFixture('backend-old.log', line(first) + line(second), 1000);
        await writeFixture('backend-new.log.1', `${line(third)}{broken\n \n${line(fourth)}`, 2000);
        await writeFixture('unrelated.log', line(entry('ignored')), 3000);
        const file = await loadSink();
        await expect(file.readRecentLogs()).resolves.toEqual([fourth, third, second, first]);
        await expect(file.readRecentLogs({ level: 'warn' })).resolves.toEqual([second, first]);
        const since = Date.parse('2026-01-02T00:00:00.000+08:00');
        await expect(file.readRecentLogs({ level: 'warn', since })).resolves.toEqual([second]);
        await expect(file.readRecentLogs({ limit: 1 })).resolves.toEqual([fourth]);
        await expect(file.readRecentLogs({ limit: -2 })).resolves.toEqual([fourth]);
    });

    it('caps default and requested limits at 200 and 2000', async () => {
        const records = Array.from({ length: 2001 }, (_, index) => entry(String(index)));
        await writeFixture('backend-many.log', records.map(line).join(''));
        const file = await loadSink();
        expect(await file.readRecentLogs()).toEqual(records.slice(-200).reverse());
        expect(await file.readRecentLogs({ limit: 9000 })).toEqual(records.slice(-2000).reverse());
        expect(await file.readRecentLogs({ limit: 0 })).toEqual([records.at(-1)]);
    });

    it('falls back on stat failure and skips unreadable files without dropping other records', async () => {
        const statFailed = await writeFixture('backend-stat-failed.log', line(entry('stat-fallback')), 1000);
        const unreadable = await writeFixture('backend-unreadable.log', line(entry('unreadable')), 3000);
        await writeFixture('backend-good.log', line(entry('good')), 2000);
        const originalStat = fs.stat.bind(fs);
        vi.spyOn(fs, 'stat').mockImplementation((...args: Parameters<typeof fs.stat>) => {
            if (args[0] === statFailed) return Promise.reject(new Error('stat denied'));
            return originalStat(...args);
        });
        const originalRead = fs.readFile.bind(fs);
        vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => {
            if (args[0] === unreadable) return Promise.reject(new Error('read denied'));
            return originalRead(...args);
        });
        const file = await loadSink();
        await expect(file.readRecentLogs()).resolves.toEqual([entry('good'), entry('stat-fallback')]);
    });
});

describe('logging end-to-end logger dispatch', () => {
    it('dispatches all levels to console/file with inherited child bindings and sanitized fields', async () => {
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { createLogger, rootLogger, flushLogs } = await import('@/platform/logging');
        const file = await loadSink();
        const parent = createLogger('Parent').child({ requestId: 'request', parent: true });
        const child = parent.child({ module: 'Child', child: true });
        child.info('info', { password: 'synthetic', count: 3 });
        child.debug('debug');
        parent.warn('warn');
        rootLogger.error('error');
        await flushLogs();
        const lines = (await fs.readFile(file.currentLogFilePath(), 'utf8')).trim().split('\n');
        const records = lines.map((value) => JSON.parse(value) as LogRecord);
        expect(records.map((value) => value.level)).toEqual(['info', 'debug', 'warn', 'error']);
        expect(records[0]).toMatchObject({
            module: 'Child',
            requestId: 'request',
            parent: true,
            child: true,
            password: '***REDACTED***',
            count: 3
        });
        expect(records[0].ts).toMatch(/\+08:00$/);
        expect(records[2]).toMatchObject({ module: 'Parent', parent: true });
        expect(records[2]).not.toHaveProperty('child');
        expect(records[3]).not.toHaveProperty('module');
        expect(stdout.mock.calls.map(([value]) => value)).toEqual(lines.slice(0, 2));
        expect(stderr.mock.calls.map(([value]) => value)).toEqual(lines.slice(2));
    });

    it('filters below the initialized threshold and bypasses the disabled file sink', async () => {
        vi.stubEnv('LOG_LEVEL', 'warn');
        vi.stubEnv('LOG_TO_FILE', 'false');
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { rootLogger } = await import('@/platform/logging');
        const file = await loadSink();
        rootLogger.info('hidden');
        rootLogger.debug('hidden');
        rootLogger.warn('shown');
        rootLogger.error('shown too');
        await file.flushLogs();
        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledTimes(2);
        await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
