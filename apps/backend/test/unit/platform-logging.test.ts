import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogRecord } from '@/platform/logging/logger';

import { createTempData, type TempData } from '../helpers/temp-data';

let temp: TempData;
let ttyDescriptor: PropertyDescriptor | undefined;

beforeEach(async () => {
    vi.resetModules();
    temp = await createTempData('zhuixun-platform-logging-unit-');
    vi.stubEnv('LOG_DIR', path.join(temp.root, 'logs'));
    vi.stubEnv('LOG_TO_FILE', 'false');
    vi.stubEnv('LOG_FORMAT', 'pretty');
    vi.stubEnv('LOG_LEVEL', 'debug');
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
});

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    await temp.cleanup();
});

function record(overrides: Partial<LogRecord> = {}): LogRecord {
    return { ts: '2026-01-02T03:04:05.006+08:00', level: 'info', msg: 'hello', ...overrides };
}

function setTTY(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

describe('logging levels and timestamps', () => {
    it.each(['error', 'warn', 'info', 'debug'] as const)('resolves case-insensitive %s threshold', async (level) => {
        vi.stubEnv('LOG_LEVEL', level.toUpperCase());
        const { resolveLevel } = await import('@/platform/logging/levels');
        expect(resolveLevel()).toBe(level);
    });

    it.each([
        ['production', undefined, 'info'],
        ['production', 'invalid', 'info'],
        ['test', '', 'debug'],
        ['development', 'invalid', 'debug']
    ])('falls back in %s with %j', async (environment, value, expected) => {
        vi.stubEnv('NODE_ENV', environment);
        vi.stubEnv('LOG_LEVEL', value);
        const { resolveLevel } = await import('@/platform/logging/levels');
        expect(resolveLevel()).toBe(expected);
    });

    it('enables exactly the current level and more severe levels', async () => {
        const { isEnabled } = await import('@/platform/logging/levels');
        const levels = ['error', 'warn', 'info', 'debug'] as const;
        for (const [currentIndex, current] of levels.entries()) {
            for (const [targetIndex, target] of levels.entries()) {
                expect(isEnabled(current, target)).toBe(targetIndex <= currentIndex);
            }
        }
    });

    it('uses Shanghai midnight and +08:00 regardless of machine timezone', async () => {
        const { currentDate, nowTimestamp } = await import('@/platform/logging/time');
        expect(currentDate(new Date('2025-12-31T15:59:59.999Z'))).toBe('2025-12-31');
        expect(currentDate(new Date('2025-12-31T16:00:00.000Z'))).toBe('2026-01-01');
        expect(nowTimestamp(new Date('2025-12-31T16:00:00.123Z'))).toBe('2026-01-01T00:00:00.123+08:00');
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-06T01:02:03.004Z'));
        expect(currentDate()).toBe('2026-05-06');
        expect(nowTimestamp()).toBe('2026-05-06T09:02:03.004+08:00');
    });
});

describe('logging console sink', () => {
    it.each(['info', 'debug', 'warn', 'error'] as const)('routes JSON %s to the correct stream', async (level) => {
        vi.stubEnv('LOG_FORMAT', 'json');
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { writeConsole } = await import('@/platform/logging/sinks/console');
        const entry = record({ level, module: 'Test', count: 2 });
        writeConsole(entry);
        const [selected, other] = level === 'error' || level === 'warn' ? [stderr, stdout] : [stdout, stderr];
        expect(selected).toHaveBeenCalledExactlyOnceWith(JSON.stringify(entry));
        expect(other).not.toHaveBeenCalled();
    });

    it('formats tags, shortened request ID and only non-reserved extras without ANSI on non-TTY', async () => {
        setTTY(false);
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { writeConsole } = await import('@/platform/logging/sinks/console');
        writeConsole(record({ module: 'Chat', requestId: '123456789abcdef', answer: 42 }));
        expect(stdout).toHaveBeenCalledExactlyOnceWith('03:04:05.006 INFO  [Chat] 12345678 hello {"answer":42}');
    });

    it('omits absent tags and extra fields', async () => {
        setTTY(false);
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { writeConsole } = await import('@/platform/logging/sinks/console');
        writeConsole(record());
        expect(stdout).toHaveBeenCalledExactlyOnceWith('03:04:05.006 INFO   hello');
    });

    it('applies each severity color only for pretty TTY output', async () => {
        setTTY(true);
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { writeConsole } = await import('@/platform/logging/sinks/console');
        for (const [level, color] of [
            ['error', '31'],
            ['warn', '33'],
            ['info', '36'],
            ['debug', '90']
        ] as const) {
            writeConsole(record({ level }));
            const selected = level === 'error' || level === 'warn' ? stderr : stdout;
            expect(selected.mock.lastCall?.[0]).toContain(`\x1b[${color}m${level.toUpperCase().padEnd(5)}\x1b[0m`);
            expect(selected.mock.lastCall?.[0]).toContain('\x1b[2m03:04:05.006\x1b[0m');
        }
    });

    it.each(['json', 'pretty'])('handles unserializable %s payloads without throwing', async (format) => {
        vi.stubEnv('LOG_FORMAT', format);
        setTTY(false);
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { writeConsole } = await import('@/platform/logging/sinks/console');
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(() => writeConsole(record({ circular }))).not.toThrow();
        expect(stdout.mock.lastCall?.[0]).toContain('[unserializable]');
    });
});

describe('logging redaction', () => {
    it('masks sensitive keys recursively without changing the input', async () => {
        const { redact } = await import('@/platform/logging/redact');
        const keys = [
            'apiKey',
            'API_KEY',
            'access-token',
            'refreshToken',
            'Authorization',
            'AUTH',
            'secret',
            'password',
            'passwd',
            'pwd',
            'token',
            'Cookie',
            'Bearer',
            'client-secret',
            'x-api-key'
        ];
        const sensitive = Object.fromEntries(keys.map((key) => [key, { hidden: 'value' }]));
        const input = { safe: 'public', nested: sensitive };
        expect(redact(input)).toEqual({
            safe: 'public',
            nested: Object.fromEntries(keys.map((key) => [key, '***REDACTED***']))
        });
        expect(input.nested.apiKey).toEqual({ hidden: 'value' });
    });

    it('masks long configured secrets in free text and Error fields but ignores short/empty values', async () => {
        vi.stubEnv('TEST_LOG_API_KEY', 'synthetic-long-key-123');
        vi.stubEnv('TEST_LOG_PASSWORD', 'tiny');
        vi.stubEnv('TEST_LOG_SECRET', '');
        const { redact } = await import('@/platform/logging/redact');
        const error = new Error('synthetic-long-key-123 failed');
        error.stack = 'stack synthetic-long-key-123';
        expect(redact(['synthetic-long-key-123 / synthetic-long-key-123 tiny', error])).toEqual([
            '***REDACTED*** / ***REDACTED*** tiny',
            { name: 'Error', message: '***REDACTED*** failed', stack: 'stack ***REDACTED***' }
        ]);
        error.stack = undefined;
        expect(redact(error)).toEqual({ name: 'Error', message: '***REDACTED*** failed', stack: undefined });
    });

    it('preserves scalar values, labels functions and stringifies symbols', async () => {
        const { redact } = await import('@/platform/logging/redact');
        const named = function example() {};
        const anonymous = () => {};
        Object.defineProperty(anonymous, 'name', { value: '' });
        expect(redact([null, undefined, 0, false, 1n, named, anonymous, Symbol('test')])).toEqual([
            null,
            undefined,
            0,
            false,
            1n,
            '[Function example]',
            '[Function anonymous]',
            'Symbol(test)'
        ]);
    });

    it('bounds strings, arrays, recursion and circular references', async () => {
        const { redact } = await import('@/platform/logging/redact');
        expect(redact('x'.repeat(10_000))).toBe('x'.repeat(10_000));
        expect(redact('x'.repeat(10_001))).toBe(`${'x'.repeat(10_000)}…(10001 字符)`);
        expect(redact(Array.from({ length: 101 }, (_, i) => i))).toEqual(Array.from({ length: 100 }, (_, i) => i));
        const circular: unknown[] = [];
        circular.push(circular);
        expect(redact(circular)).toEqual(['[Circular]']);
        const object: Record<string, unknown> = {};
        object.self = object;
        expect(redact(object)).toEqual({ self: '[Circular]' });
        let nested: unknown = { leaf: true };
        for (let i = 0; i < 8; i++) nested = { child: nested };
        let result = redact(nested) as { child: unknown };
        for (let i = 0; i < 7; i++) result = result.child as { child: unknown };
        expect(result.child).toBe('[Depth limit]');
    });
});

describe('logging request context', () => {
    it('preserves independent asynchronous contexts, nested restoration and fallback', async () => {
        vi.stubEnv('LOG_FORMAT', 'json');
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { getLogger, createLogger, runWithRequest, getRequestContext, getRequestId } =
            await import('@/platform/logging');
        expect(getRequestContext()).toBeUndefined();
        expect(getRequestId()).toBeUndefined();
        getLogger('Background').info('outside');
        await Promise.all(
            ['request-a', 'request-b'].map((requestId) =>
                runWithRequest({ requestId, logger: createLogger('Request').child({ requestId }) }, async () => {
                    await Promise.resolve();
                    expect(getRequestId()).toBe(requestId);
                    expect(getRequestContext()?.requestId).toBe(requestId);
                    expect(
                        runWithRequest({ requestId: 'inner', logger: createLogger('Inner') }, () => getRequestId())
                    ).toBe('inner');
                    expect(getRequestId()).toBe(requestId);
                    getLogger('Chat').info('inside');
                })
            )
        );
        expect(getRequestId()).toBeUndefined();
        const output = stdout.mock.calls.map(([line]) => JSON.parse(String(line)) as LogRecord);
        expect(output).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ module: 'Background', msg: 'outside' }),
                expect.objectContaining({ module: 'Chat', requestId: 'request-a' }),
                expect.objectContaining({ module: 'Chat', requestId: 'request-b' })
            ])
        );
        expect(output[0]).not.toHaveProperty('requestId');
        expect(() =>
            runWithRequest({ requestId: 'throws', logger: createLogger('Test') }, () => {
                throw new Error('failure');
            })
        ).toThrow('failure');
        expect(getRequestContext()).toBeUndefined();
    });
});
