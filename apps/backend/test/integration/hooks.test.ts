import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import { getHooksSettings, updateHooksSettings } from '@/config/settings-store';
import {
    createHookRunner,
    hooksView,
    HooksTrustError,
    readHookAudit,
    resetHooksCache,
    updateHooksTrust
} from '@/modules/hooks';
import { hashContent, parseHooksConfig } from '@/modules/hooks/config';
import { executeHookCommand, flushHookAudit, interpretExecution } from '@/modules/hooks/runner';

class FakeChild extends EventEmitter {
    pid = 515151;
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = new PassThrough();
    kill = vi.fn(() => true);
}

type Script = (child: FakeChild, stdin: string, env: NodeJS.ProcessEnv) => void;

/** 按调用顺序为每次 spawn 安装一个脚本；脚本在 stdin 写完后执行。 */
function fakeSpawn(...scripts: Script[]) {
    vi.mocked(spawn).mockImplementation(((_bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        const child = new FakeChild();
        const script = scripts.shift() ?? ((c: FakeChild) => c.emit('close', 0));
        let stdin = '';
        child.stdin.on('data', (chunk: Buffer) => (stdin += chunk.toString()));
        child.stdin.on('finish', () => setImmediate(() => script(child, stdin, opts.env)));
        return child;
    }) as unknown as typeof spawn);
}

const exit =
    (code: number, stdout = '', stderr = ''): Script =>
    (child) => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        setImmediate(() => child.emit('close', code));
    };

function writeHooks(config: unknown): string {
    const content = typeof config === 'string' ? config : JSON.stringify(config);
    fs.mkdirSync(path.dirname(paths.hooksFile()), { recursive: true });
    fs.writeFileSync(paths.hooksFile(), content);
    resetHooksCache();
    return hashContent(content);
}

function trust(config: unknown) {
    const hash = writeHooks(config);
    updateHooksSettings({ enabled: true, trustedHash: hash });
}

const editHooks = {
    PreToolUse: [{ matcher: 'Bash|Edit', hooks: [{ type: 'command', command: 'check.sh', timeout: 1 }] }],
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }]
};

beforeEach(() => {
    vi.stubEnv('ZHUIXUN_SHELL', '/fake/bash');
    fs.rmSync(paths.hooksFile(), { force: true });
    fs.rmSync(paths.hooksAuditFile(), { force: true });
    updateHooksSettings({ enabled: false, trustedHash: '' });
    resetHooksCache();
});
afterEach(async () => {
    // 审计异步写入，先排空队列，避免下一用例清理后重新生成审计文件。
    await flushHookAudit();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('hooks config', () => {
    it('parses events, anchors matchers and clamps timeouts', () => {
        const config = parseHooksConfig(
            JSON.stringify({
                PreToolUse: [
                    { matcher: 'Bash|Edit', hooks: [{ type: 'command', command: 'a', timeout: 999 }] },
                    { hooks: [{ type: 'command', command: 'b', timeout: 0 }] }
                ]
            })
        );
        expect(config.PreToolUse[0].pattern?.test('Bash')).toBe(true);
        expect(config.PreToolUse[0].pattern?.test('BashX')).toBe(false);
        expect(config.PreToolUse.map((e) => e.hooks[0].timeout)).toEqual([60, 1]);
        expect(config.PostToolUse).toEqual([]);
        expect(
            parseHooksConfig('{"Stop":[{"hooks":[{"type":"command","command":"x","timeout":"5"}]}]}').Stop[0].hooks[0]
                .timeout
        ).toBe(10);
    });

    it.each([
        ['[]', '顶层'],
        ['{"Other":[]}', '不支持的事件'],
        ['{"Stop":{}}', '必须是数组'],
        ['{"Stop":[null]}', '必须是对象'],
        ['{"Stop":[{"matcher":1,"hooks":[]}]}', 'matcher 必须是字符串'],
        ['{"Stop":[{"matcher":"(","hooks":[]}]}', '不是合法正则'],
        ['{"Stop":[{"hooks":[]}]}', '非空数组'],
        ['{"Stop":[{"hooks":[{"type":"http"}]}]}', '仅支持'],
        ['{"Stop":[{"hooks":[{"type":"command","command":" "}]}]}', '不能为空']
    ])('rejects %s', (raw, message) => {
        expect(() => parseHooksConfig(raw)).toThrow(message);
    });

    it('rejects more than 20 commands per event', () => {
        const hooks = Array.from({ length: 21 }, () => ({ type: 'command', command: 'x' }));
        expect(() => parseHooksConfig(JSON.stringify({ Stop: [{ hooks }] }))).toThrow('上限');
    });

    it('reports absent / error / untrusted / disabled / active and reloads on change', () => {
        expect(hooksView()).toMatchObject({
            status: 'absent',
            enabled: false,
            trusted: false,
            path: paths.hooksFile()
        });
        writeHooks('{bad');
        expect(hooksView()).toMatchObject({
            status: 'error',
            error: expect.stringContaining('解析失败'),
            content: '{bad'
        });
        const hash = writeHooks(editHooks);
        expect(hooksView()).toMatchObject({
            status: 'untrusted',
            hash,
            counts: { PreToolUse: 1, PostToolUse: 1, Stop: 1 }
        });
        expect(updateHooksTrust({ hash })).toMatchObject({ status: 'disabled', trusted: true });
        expect(updateHooksTrust({ enabled: true })).toMatchObject({ status: 'active' });
        expect(getHooksSettings()).toEqual({ enabled: true, trustedHash: hash });
        // 文件被改：回到待信任
        writeHooks({ ...editHooks, Stop: [] });
        expect(hooksView().status).toBe('untrusted');
        expect(createHookRunner().matches('PreToolUse', 'Bash')).toBe(false);
    });

    it('rejects trusting a stale hash (TOCTOU) or a file that fails to parse', () => {
        writeHooks(editHooks);
        expect(() => updateHooksTrust({ hash: 'a'.repeat(64) })).toThrow(HooksTrustError);
        const bad = writeHooks('{bad');
        expect(() => updateHooksTrust({ hash: bad })).toThrow('配置已变化');
    });

    it('treats an unreadable hooks path as an error', () => {
        writeHooks('{}');
        vi.stubEnv('HOOKS_CONFIG_PATH', path.join(paths.hooksFile(), 'nested.json'));
        resetHooksCache();
        expect(hooksView()).toMatchObject({ status: 'error', error: 'hooks.json 无法读取' });
    });
});

describe('hook execution', () => {
    it('interprets exit codes and JSON output', () => {
        const base = { stdout: '', stderr: '', timedOut: false, durationMs: 1 };
        expect(interpretExecution({ ...base, exitCode: 2, stderr: ' blocked ' })).toEqual({
            decision: 'deny',
            failed: false,
            reason: 'blocked'
        });
        expect(interpretExecution({ ...base, exitCode: 2 })).toMatchObject({ decision: 'deny', reason: undefined });
        expect(interpretExecution({ ...base, exitCode: 1, stderr: 'oops' })).toMatchObject({
            failed: true,
            reason: 'hook 退出码 1：oops'
        });
        expect(interpretExecution({ ...base, exitCode: 3 }).reason).toBe('hook 退出码 3');
        expect(interpretExecution({ ...base, exitCode: null, timedOut: true }).reason).toBe('hook 执行超时');
        expect(interpretExecution({ ...base, exitCode: null, spawnError: 'ENOENT' }).reason).toContain('无法启动');
        expect(interpretExecution({ ...base, exitCode: 0, stdout: 'plain' })).toEqual({
            decision: 'none',
            failed: false
        });
        expect(interpretExecution({ ...base, exitCode: 0, stdout: '{bad' })).toEqual({
            decision: 'none',
            failed: false
        });
        expect(
            interpretExecution({
                ...base,
                exitCode: 0,
                stdout: '{"decision":"allow","reason":"ok","additionalContext":"ctx"}'
            })
        ).toEqual({ decision: 'allow', failed: false, reason: 'ok', additionalContext: 'ctx' });
        expect(interpretExecution({ ...base, exitCode: 0, stdout: '{"decision":"maybe"}' }).decision).toBe('none');
    });

    it('writes the payload to stdin, caps output and reports spawn failures', async () => {
        fakeSpawn((child, stdin) => {
            child.stdout.write(Buffer.alloc(70 * 1024, 'a'));
            child.stdout.write('tail');
            child.stderr.write(stdin);
            setImmediate(() => child.emit('close', 0));
        });
        const exec = await executeHookCommand({ command: 'x', timeout: 5 }, { event: 'Stop' }, {}, '/tmp');
        expect(exec.stdout).toHaveLength(64 * 1024);
        expect(JSON.parse(exec.stderr)).toEqual({ event: 'Stop' });
        expect(vi.mocked(spawn).mock.lastCall?.[2]).toMatchObject({ cwd: '/tmp', detached: true });

        fakeSpawn((child) => child.emit('error', new Error('ENOENT')));
        expect(await executeHookCommand({ command: 'x', timeout: 5 }, {}, {}, '/tmp')).toMatchObject({
            exitCode: null,
            spawnError: 'ENOENT'
        });
        vi.mocked(spawn).mockImplementationOnce(() => {
            throw new Error('EINVAL');
        });
        expect(await executeHookCommand({ command: 'x', timeout: 5 }, {}, {}, '/tmp')).toMatchObject({
            spawnError: 'EINVAL'
        });
    });

    it('kills the process group on timeout and settles even without close', async () => {
        vi.useFakeTimers();
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
        fakeSpawn(() => {});
        const pending = executeHookCommand({ command: 'sleep', timeout: 1 }, {}, {}, '/tmp');
        await vi.advanceTimersByTimeAsync(1000);
        expect(kill).toHaveBeenCalledWith(-515151, 'SIGKILL');
        await vi.advanceTimersByTimeAsync(2000);
        await expect(pending).resolves.toMatchObject({ exitCode: null, timedOut: true });
        kill.mockRestore();
    });
});

describe('hook runner', () => {
    it('does nothing when hooks are absent, untrusted or disabled', async () => {
        const runner = createHookRunner();
        expect(runner.matches('PreToolUse', 'Bash')).toBe(false);
        await expect(runner.pre({ toolName: 'Bash', input: {} })).resolves.toEqual({ decision: 'none' });
        writeHooks(editHooks);
        expect(runner.matches('PreToolUse', 'Bash')).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('merges PreToolUse results strictest-first and passes env + payload', async () => {
        trust({
            PreToolUse: [
                {
                    matcher: 'Edit',
                    hooks: [
                        { type: 'command', command: 'a' },
                        { type: 'command', command: 'b' }
                    ]
                }
            ]
        });
        const runner = createHookRunner({ sessionId: 's', projectId: 'p', cwd: '/project' });
        expect(runner.matches('PreToolUse', 'Edit')).toBe(true);
        expect(runner.matches('PreToolUse', 'Bash')).toBe(false);
        let seen: { stdin: string; env: NodeJS.ProcessEnv } | undefined;
        fakeSpawn(
            (child, stdin, env) => {
                seen = { stdin, env };
                exit(0, '{"decision":"allow"}')(child, stdin, env);
            },
            exit(2, '', 'no edits on main')
        );
        await expect(runner.pre({ toolName: 'Edit', input: { file_path: 'src/a.ts' } })).resolves.toEqual({
            decision: 'deny',
            reason: 'no edits on main'
        });
        expect(JSON.parse(seen!.stdin)).toEqual({
            event: 'PreToolUse',
            sessionId: 's',
            projectId: 'p',
            cwd: '/project',
            toolName: 'Edit',
            toolInput: { file_path: 'src/a.ts' }
        });
        expect(seen!.env).toMatchObject({
            ZHUIXUN_HOOK_EVENT: 'PreToolUse',
            ZHUIXUN_TOOL_NAME: 'Edit',
            ZHUIXUN_FILE_PATH: path.resolve('/project', 'src/a.ts')
        });

        fakeSpawn(exit(0, '{"decision":"ask","reason":"r"}'), exit(1));
        await expect(runner.pre({ toolName: 'Edit', input: {} })).resolves.toEqual({
            decision: 'ask',
            reason: 'r；hook 退出码 1'
        });
        fakeSpawn(exit(1), exit(0));
        await expect(runner.pre({ toolName: 'Edit', input: { path: 'x' } })).resolves.toEqual({
            decision: 'ask',
            failed: true,
            reason: 'hook 退出码 1'
        });
        fakeSpawn(exit(0, '{"decision":"allow"}'), exit(0));
        await expect(runner.pre({ toolName: 'Edit', input: null })).resolves.toEqual({ decision: 'allow' });
        fakeSpawn(exit(0), exit(0));
        await expect(runner.pre({ toolName: 'Edit', input: {} })).resolves.toEqual({ decision: 'none' });

        await flushHookAudit();
        const audit = await readHookAudit(3);
        expect(audit).toHaveLength(3);
        expect(audit[0]).toMatchObject({ event: 'PreToolUse', toolName: 'Edit', matcher: 'Edit', decision: 'none' });
        expect(JSON.stringify(await readHookAudit())).not.toContain('src/a.ts');
    });

    it('collects PostToolUse context, ignores failures and runs Stop in the temp workspace', async () => {
        trust(editHooks);
        const runner = createHookRunner({ sessionId: 's' });
        let stdin = '';
        fakeSpawn((child, input) => {
            stdin = input;
            exit(0, '{"decision":"deny","reason":"lint","additionalContext":"2 errors"}')(child, input, {});
        });
        await expect(runner.post({ toolName: 'Edit', input: {} }, { big: 'x'.repeat(30_000) })).resolves.toEqual({
            blocked: true,
            reason: 'lint',
            additionalContext: '2 errors'
        });
        expect(JSON.parse(stdin).toolOutput.length).toBeLessThan(21_000);
        fakeSpawn(exit(1));
        await expect(runner.post({ toolName: 'Edit', input: {} }, 'out')).resolves.toEqual({});
        fakeSpawn(exit(0, '{"decision":"deny"}'));
        await expect(runner.post({ toolName: 'Edit', input: {} }, 1n)).resolves.toEqual({ blocked: true });

        fakeSpawn(exit(0));
        await runner.stop({ stopReason: 'max-steps', lastAssistantText: 'y'.repeat(3000) });
        await runner.stop({});
        expect(vi.mocked(spawn).mock.calls.at(-2)?.[2]).toMatchObject({
            cwd: expect.stringContaining('zhuixun-workspace')
        });
    });

    it('reads audit newest-first, skipping corrupt lines', async () => {
        await expect(readHookAudit()).resolves.toEqual([]);
        fs.mkdirSync(paths.auditDir(), { recursive: true });
        fs.writeFileSync(paths.hooksAuditFile(), '{"command":"a"}\nbad\n{"command":"b"}\n');
        await expect(readHookAudit()).resolves.toEqual([{ command: 'b' }, { command: 'a' }]);
    });
});
