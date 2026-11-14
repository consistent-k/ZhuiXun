import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as env from '@/config/env';
import * as logging from '@/config/logging';
import { ZHUIXUN_HOME, ensureDirSafe, paths, resolveUserPath } from '@/config/paths';
import { isDev, isProd } from '@/config/runtime';
import * as server from '@/config/server';
import * as shell from '@/config/shell';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('configuration primitives', () => {
    it('parses optional strings, lists and numbers with explicit defaults', () => {
        vi.stubEnv('FIXTURE_CONFIG', undefined);
        expect(env.optional('FIXTURE_CONFIG')).toBeUndefined();
        expect(env.str('FIXTURE_CONFIG', 'default')).toBe('default');
        expect(env.num('FIXTURE_CONFIG', 10)).toBe(10);
        expect(env.list('FIXTURE_CONFIG')).toEqual([]);
        for (const value of ['', ' ', 'NaN', 'Infinity']) {
            vi.stubEnv('FIXTURE_CONFIG', value);
            expect(env.num('FIXTURE_CONFIG', 10)).toBe(10);
        }
        vi.stubEnv('FIXTURE_CONFIG', '  ');
        expect(env.str('FIXTURE_CONFIG')).toBe('');
        vi.stubEnv('FIXTURE_CONFIG', '  value  ');
        expect(env.str('FIXTURE_CONFIG')).toBe('  value  ');
        vi.stubEnv('FIXTURE_CONFIG', '-3');
        expect(env.num('FIXTURE_CONFIG', 10)).toBe(-3);
        expect(env.num('FIXTURE_CONFIG', 10, { positive: true })).toBe(10);
        vi.stubEnv('FIXTURE_CONFIG', '2.5');
        expect(env.num('FIXTURE_CONFIG', 10, { positive: true })).toBe(2.5);
        vi.stubEnv('FIXTURE_CONFIG', 'a, , b');
        expect(env.list('FIXTURE_CONFIG')).toEqual(['a', 'b']);
        vi.stubEnv('FIXTURE_CONFIG', ' a ; b ; ');
        expect(env.list('FIXTURE_CONFIG', ';')).toEqual(['a', 'b']);
    });

    it.each(['1', 'TRUE', ' yes ', 'On', '0', 'FALSE', 'no', 'off', '', 'unknown', undefined])(
        'parses boolean %s',
        (value) => {
            vi.stubEnv('FIXTURE_CONFIG', value);
            const truthy = ['1', 'TRUE', ' yes ', 'On'].includes(value ?? 'missing');
            const falsy = ['0', 'FALSE', 'no', 'off'].includes(value ?? 'missing');
            expect(env.bool('FIXTURE_CONFIG', false)).toBe(truthy);
            expect(env.bool('FIXTURE_CONFIG', true)).toBe(!falsy);
        }
    );

    it('reads runtime, server and logging settings lazily', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('LOG_TO_FILE', undefined);
        vi.stubEnv('LOG_FORMAT', undefined);
        expect(isProd()).toBe(true);
        expect(isDev()).toBe(false);
        expect(logging.logToFile()).toBe(true);
        expect(logging.logFormat()).toBe('json');
        vi.stubEnv('NODE_ENV', 'test');
        expect(isDev()).toBe(true);
        expect(logging.logFormat()).toBe('pretty');
        expect(logging.logToFile()).toBe(false);
        vi.stubEnv('LOG_FORMAT', 'JSON');
        vi.stubEnv('LOG_TO_FILE', 'yes');
        vi.stubEnv('LOG_MAX_FILE_MB', '2');
        vi.stubEnv('LOG_RETENTION_DAYS', '3');
        expect(logging.logFormat()).toBe('json');
        expect(logging.logToFile()).toBe(true);
        expect(logging.logMaxBytes()).toBe(2 * 1024 * 1024);
        expect(logging.logRetentionDays()).toBe(3);
        expect(logging.logDir()).toBe(paths.logsDir());
        vi.stubEnv('LOG_FORMAT', 'pretty');
        expect(logging.logFormat()).toBe('pretty');
        vi.stubEnv('LOG_FORMAT', 'invalid');
        expect(logging.logFormat()).toBe('pretty');
        vi.stubEnv('PORT', undefined);
        expect(server.port()).toBe(31001);
        expect(server.HOST).toBe('127.0.0.1');
        vi.stubEnv('PORT', '32002');
        vi.stubEnv('ALLOWED_ORIGINS', 'app://local, https://fixture.invalid,');
        vi.stubEnv('API_AUTH_TOKEN', 'synthetic-token');
        expect(server.oauthCallbackUrl()).toBe('http://localhost:32002/api/mcp/oauth/callback');
        expect(server.allowedOrigins()).toEqual([
            'app://local',
            'http://localhost:8080',
            'http://127.0.0.1:8080',
            'https://fixture.invalid'
        ]);
        expect(server.apiAuthToken()).toBe('synthetic-token');
    });
});

describe('path and shell configuration', () => {
    it('keeps all writable defaults inside isolated home and respects each explicit override', () => {
        expect(ZHUIXUN_HOME).toBe(path.join(os.homedir(), '.zhuixun'));
        expect(resolveUserPath(' custom ', 'ignored')).toBe('custom');
        expect(resolveUserPath('  ', 'nested')).toBe(path.join(ZHUIXUN_HOME, 'nested'));
        const cases = [
            ['skillsDir', 'SKILLS_USER_DIR', 'skills'],
            ['mcpConfigPath', 'MCP_CONFIG_PATH', '.mcp.json'],
            ['settingsPath', 'SETTINGS_CONFIG_PATH', 'settings.json'],
            ['mcpOAuthFile', 'MCP_OAUTH_PATH', 'mcp-oauth.json'],
            ['streamsDir', 'STREAMS_USER_DIR', 'streams'],
            ['sessionsDir', 'SESSIONS_USER_DIR', 'sessions'],
            ['memoryDir', 'MEMORY_USER_DIR', 'memory'],
            ['permissionDir', 'PERMISSION_USER_DIR', ''],
            ['projectsDir', 'PROJECTS_USER_DIR', 'projects'],
            ['logsDir', 'LOG_DIR', 'logs'],
            ['channelsDir', 'CHANNELS_USER_DIR', 'channels'],
            ['tasksDir', 'TASKS_USER_DIR', 'tasks']
        ] as const;
        for (const [fn, key, fallback] of cases) {
            vi.stubEnv(key, undefined);
            expect(paths[fn]()).toBe(path.join(ZHUIXUN_HOME, fallback));
            vi.stubEnv(key, path.join(os.homedir(), key));
            expect(paths[fn]()).toBe(path.join(os.homedir(), key));
        }
        expect(paths.permissionFile()).toBe(path.join(paths.permissionDir(), 'permissions.json'));
        expect(paths.streamFile('session')).toBe(path.join(paths.streamsDir(), 'session.ndjson'));
        expect(paths.tasksFile('session')).toBe(path.join(paths.tasksDir(), 'session.json'));
        expect(paths.sessionUploadsDir('session')).toBe(path.join(paths.sessionsDir(), 'session', 'uploads'));
        expect(paths.auditFile()).toBe(path.join(ZHUIXUN_HOME, 'audit', 'shell-audit.jsonl'));
        expect(paths.webAuditFile()).toBe(path.join(ZHUIXUN_HOME, 'audit', 'web-audit.jsonl'));
        vi.stubEnv('SKILLS_EXTERNAL_DIRS', undefined);
        expect(paths.externalSkillDirs()).toEqual([
            path.join(os.homedir(), '.agents', 'skills'),
            path.join(os.homedir(), '.agents')
        ]);
        vi.stubEnv('SKILLS_EXTERNAL_DIRS', ` first ${path.delimiter} ${path.delimiter} second `);
        expect(paths.externalSkillDirs()).toEqual(['first', 'second']);
    });

    it('creates sandbox directories and reports permission failures without throwing', () => {
        const dir = path.join(os.homedir(), 'config-dir');
        expect(ensureDirSafe(dir)).toBe(true);
        expect(fs.statSync(dir).isDirectory()).toBe(true);
        vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
            throw new Error('denied');
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(ensureDirSafe(dir, 'fixture')).toBe(false);
        expect(warn).toHaveBeenCalledWith(
            '[Paths] 创建目录失败',
            expect.objectContaining({ context: 'fixture', err: 'denied' })
        );
        vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
            throw 'untyped failure';
        });
        expect(ensureDirSafe(dir)).toBe(false);
    });

    it.each([
        ['pwsh.exe', 'powershell'],
        ['C:\\Windows\\PowerShell.exe', 'powershell'],
        ['cmd.EXE', 'cmd'],
        ['/bin/bash', 'posix']
    ])('infers shell dialect from %s', (input, expected) => {
        expect(shell.inferShellKind(input)).toBe(expected);
    });

    it('chooses an explicit shell or known POSIX fallback and validates timeout', () => {
        vi.stubEnv('ZHUIXUN_SHELL', 'fixture-shell');
        expect(shell.resolvePosixShell()).toEqual({ bin: 'fixture-shell', kind: 'posix' });
        vi.stubEnv('ZHUIXUN_SHELL', undefined);
        const exists = vi.spyOn(fs, 'existsSync');
        exists.mockReturnValueOnce(true);
        expect(shell.resolvePosixShell().bin).toBe('/bin/bash');
        exists.mockReturnValueOnce(false);
        expect(shell.resolvePosixShell().bin).toBe('/bin/sh');
        vi.stubEnv('ZHUIXUN_SHELL_TIMEOUT_MS', undefined);
        expect(shell.resolveShellTimeoutMs()).toBe(shell.DEFAULT_SHELL_TIMEOUT_MS);
        vi.stubEnv('ZHUIXUN_SHELL_TIMEOUT_MS', '500');
        expect(shell.resolveShellTimeoutMs()).toBe(500);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const raw of ['0', '-1', 'not-number', 'Infinity']) {
            vi.stubEnv('ZHUIXUN_SHELL_TIMEOUT_MS', raw);
            expect(shell.resolveShellTimeoutMs()).toBe(shell.DEFAULT_SHELL_TIMEOUT_MS);
        }
    });
});

describe('danger mode startup facts', () => {
    it.each(['1', 'true', ' yes ', 'ON', '0', '', undefined])('resolves env flag %s only at startup', async (flag) => {
        vi.resetModules();
        vi.stubEnv('ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS', flag);
        vi.spyOn(process, 'getuid').mockReturnValue(1000);
        const mode = await import('@/config/danger-mode');
        expect(mode.isDangerouslySkipPermissions()).toBe(['1', 'true', ' yes ', 'ON'].includes(flag ?? 'missing'));
        vi.stubEnv('ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS', '1');
        expect(mode.getDangerModeStatus()).toBe(mode.getDangerModeStatus());
    });

    it('gives CLI precedence but refuses root and handles platforms without uid', async () => {
        const argv = process.argv;
        process.argv = [...argv, '--dangerously-skip-permissions'];
        try {
            vi.spyOn(process, 'getuid').mockReturnValue(0);
            vi.resetModules();
            let mode = await import('@/config/danger-mode');
            expect(mode.getDangerModeStatus()).toMatchObject({
                enabled: false,
                uid: 0,
                deniedByRoot: true,
                source: expect.stringContaining('CLI')
            });
            vi.spyOn(process, 'getuid').mockReturnValue(1000);
            vi.resetModules();
            mode = await import('@/config/danger-mode');
            expect(mode.getDangerModeStatus()).toMatchObject({ enabled: true, source: expect.stringContaining('CLI') });
            Object.defineProperty(process, 'getuid', { configurable: true, value: undefined, writable: true });
            vi.resetModules();
            mode = await import('@/config/danger-mode');
            expect(mode.getDangerModeStatus()).toMatchObject({ enabled: true, uid: undefined });
        } finally {
            process.argv = argv;
        }
    });
});
