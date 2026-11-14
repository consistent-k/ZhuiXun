import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempData, type TempData } from '../helpers/temp-data';

let temp: TempData;
let previousLogDir: string | undefined;

beforeEach(async () => {
    temp = await createTempData('zhuixun-platform-core-');
    previousLogDir = process.env.LOG_DIR;
    process.env.LOG_DIR = path.join(temp.root, 'logs');
});

afterEach(async () => {
    vi.useRealTimers();
    if (previousLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousLogDir;
    await temp.cleanup();
});

describe('platform command parsing', () => {
    it.each(['', '   ', 'FOO=bar', 'A=1 _B=2', 'git "status"', "git 'status'", '$cmd', '程序'])(
        'rejects unparseable command %j',
        async (command) => {
            const { deriveCommandHead } = await import('@/platform/command');
            expect(deriveCommandHead(command)).toEqual({ safe: false, reason: 'unsafe' });
        }
    );

    it.each(['&', '&&', '|', '||', ';', '<', '>', '`date`', '$(date)', '\n'])(
        'rejects shell operator %j before deriving a head',
        async (operator) => {
            const { deriveCommandHead, matchesCommandScope } = await import('@/platform/command');
            const command = `git status ${operator} echo done`;
            expect(deriveCommandHead(command)).toEqual({ safe: false, reason: 'compound' });
            expect(matchesCommandScope(command, 'git:*')).toBe(false);
        }
    );

    it.each([
        ['  FOO=bar _B2=value /usr/bin/git status --short  ', '/usr/bin/git status'],
        ['npm run build production', 'npm run build'],
        ['git --version', 'git'],
        ['node ./script.js', 'node'],
        ['tool Release-2 next3', 'tool Release-2 next3'],
        ['tool file.txt next', 'tool'],
        ['git\tstatus', 'git status'],
        ['git', 'git']
    ])('derives %j as %j', async (command, head) => {
        const { deriveCommandHead } = await import('@/platform/command');
        expect(deriveCommandHead(command)).toEqual({ safe: true, head });
    });

    it.each([
        'rm',
        'rmdir',
        'dd',
        'mkfs',
        'mkfs.ext4',
        'fdisk',
        'shutdown',
        'reboot',
        'halt',
        'poweroff',
        'sudo',
        'su',
        'chmod',
        'chown',
        'chgrp',
        'kill',
        'killall',
        'pkill',
        'mv',
        '/bin/RM'
    ])('does not remember dangerous basename %j', async (program) => {
        const { deriveCommandHead } = await import('@/platform/command');
        expect(deriveCommandHead(`${program} -f target`)).toEqual({ safe: false, head: program, reason: 'denylisted' });
    });

    it.each([
        ['git log --oneline', '  git   log:*', true],
        ['git log', 'git log', true],
        ['git log', 'git:*', true],
        ['git status', 'git log', false],
        ['git log', 'gi', false],
        ['git log', ':*', false],
        ['git log', '   ', false],
        ['git log', 'git logs', false],
        ['git "log"', 'git', false],
        ['/bin/rm -f file', '/bin/rm:*', true]
    ])('matches %j against %j → %j', async (command, pattern, expected) => {
        const { matchesCommandScope } = await import('@/platform/command');
        // denylisted 只禁止记忆；技能 scope 匹配仍接受可信 head，不等于执行免审批。
        expect(matchesCommandScope(command, pattern)).toBe(expected);
    });
});

describe('platform filesystem IDs', () => {
    it.each(['a', 'Z_09-safe', 'x'.repeat(128)])('accepts boundary-safe ID %j', async (id) => {
        const { isValidId, assertValidId } = await import('@/platform/fs/id');
        expect(isValidId(id)).toBe(true);
        expect(() => assertValidId(id)).not.toThrow();
    });

    it.each([
        undefined,
        null,
        1,
        true,
        {},
        [],
        '',
        'x'.repeat(129),
        '..',
        '../id',
        '/tmp/id',
        'a\\b',
        'a.b',
        'a b',
        'a\n',
        '中文',
        'a\0'
    ])('rejects unsafe ID %j without coercing it', async (id) => {
        const { isValidId, assertValidId } = await import('@/platform/fs/id');
        expect(isValidId(id)).toBe(false);
        expect(() => assertValidId(id)).toThrow('非法id');
        expect(() => assertValidId(id, '会话编号')).toThrow('非法会话编号');
    });
});

describe('platform runtime state', () => {
    it('creates independent, initially degraded state with a precise start timestamp', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T12:34:56.789Z'));
        const { createRuntimeStatus } = await import('@/platform/runtime-status');
        const first = createRuntimeStatus();
        expect(first).toEqual({
            ready: false,
            mcp: 'unknown',
            skills: 0,
            startedAt: '2026-01-01T12:34:56.789Z',
            instanceId: expect.any(String),
            dangerSkipPermissions: false
        });
        first.ready = true;
        first.mcp = 'failed';
        first.mcpError = 'offline';
        first.skills = 9;
        first.dangerSkipPermissions = true;
        vi.setSystemTime(new Date('2026-01-01T12:34:57.789Z'));
        const second = createRuntimeStatus();
        expect(second).not.toBe(first);
        expect(second.instanceId).not.toBe(first.instanceId);
        expect(second).toEqual({
            ready: false,
            mcp: 'unknown',
            skills: 0,
            startedAt: '2026-01-01T12:34:57.789Z',
            instanceId: expect.any(String),
            dangerSkipPermissions: false
        });
    });
});

describe('platform tool naming', () => {
    it.each([
        ['server', 'read_file', 'server_read_file'],
        ['my-server.v2', 'read file/path', 'my_server_v2_read_file_path'],
        ['MCP_12', 'Read09', 'MCP_12_Read09'],
        ['中文', 'a🚀b', '___a__b'],
        ['', '', '_'],
        ['-', '_', '___'],
        // 以数字开头的 server/tool 必须补前导下划线：Gemini 要求函数名以字母或下划线开头
        ['01db', 'list', '_01db_list'],
        ['9', '1tool', '_9_1tool'],
        ['123', '', '_123_']
    ])('sanitizes %j and %j to %j', async (server, tool, expected) => {
        const { buildPrefixedToolName } = await import('@/platform/tool-naming');
        expect(buildPrefixedToolName(server, tool)).toBe(expected);
        // 所有 provider（OpenAI/Anthropic/Gemini）共用的合法函数名约束
        expect(buildPrefixedToolName(server, tool)).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    });
});
