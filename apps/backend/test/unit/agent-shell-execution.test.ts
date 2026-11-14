import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import type { ToolSet } from 'ai';
import type { CommandResult } from 'bash-tool';
import iconv from 'iconv-lite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ShellTools from '@/agent/tools/shell-tools';
import type * as PathsConfig from '@/config/paths';
import type * as ShellConfig from '@/config/shell';

const audit = vi.hoisted(() => ({
    append: vi.fn<(...args: unknown[]) => Promise<void>>(),
    mkdir: vi.fn<(...args: unknown[]) => Promise<undefined>>(),
    warn: vi.fn()
}));

vi.mock('@/platform/logging/index', () => ({
    createLogger: () => ({ info: vi.fn(), warn: audit.warn, error: vi.fn() })
}));
vi.mock('@/config/paths', async (importOriginal) => {
    const actual = await importOriginal<typeof PathsConfig>();
    return {
        ...actual,
        paths: {
            ...actual.paths,
            auditDir: () => '/__agent_shell_audit__',
            auditFile: () => '/__agent_shell_audit__/shell.jsonl'
        }
    };
});
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    const mkdir = (...args: Parameters<typeof actual.mkdir>) =>
        String(args[0]) === '/__agent_shell_audit__' ? audit.mkdir(...args) : actual.mkdir(...args);
    const appendFile = (...args: Parameters<typeof actual.appendFile>) => {
        if (String(args[0]).startsWith('/__agent_shell_audit__/')) return audit.append(...args);
        throw new Error('本测试不允许写入非 fake 审计目录');
    };
    return { ...actual, mkdir, appendFile, default: { ...actual, mkdir, appendFile } };
});
vi.mock('@/config/shell', async (importOriginal) => {
    const actual = await importOriginal<typeof ShellConfig>();
    return { ...actual, WORKSPACE_DIR: path.join(process.env.ZHUIXUN_TEST_HOME!, 'shell-workspace') };
});

class FakeChild extends EventEmitter {
    pid: number | undefined = 424242;
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = new PassThrough();
    kill = vi.fn(() => true);
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let child: FakeChild;
let tools: ToolSet;
let cwd: string;
let createShellTools: typeof ShellTools.createShellTools;

async function flushAudit() {
    // auditLog 是串行 promise 链；无需真实时钟或文件写入。
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

function bash(command = 'printf test', abortSignal?: AbortSignal): Promise<CommandResult> {
    return tools.Bash!.execute!(
        { command },
        { toolCallId: 'call-shell', messages: [], abortSignal, context: undefined }
    ) as Promise<CommandResult>;
}

beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('ZHUIXUN_SHELL', '/fake/bash');
    vi.stubEnv('ZHUIXUN_SHELL_TIMEOUT_MS', '100');
    audit.append.mockReset().mockResolvedValue();
    audit.mkdir.mockReset().mockResolvedValue(undefined);
    audit.warn.mockReset();
    child = new FakeChild();
    vi.mocked(spawn)
        .mockReset()
        .mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    cwd = await fsp.mkdtemp(path.join(process.env.ZHUIXUN_TEST_HOME!, 'shell-exec-'));
    ({ createShellTools } = await import('@/agent/tools/shell-tools'));
    tools = await createShellTools(cwd, { primaryDir: cwd, additionalDirs: ['/extra/project'] });
});

afterEach(async () => {
    await flushAudit();
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    Object.defineProperty(process, 'platform', originalPlatform);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fsp.rm(cwd, { recursive: true, force: true });
});

describe('real Bash.execute using fake child process', () => {
    it('collects UTF-8 stdout/stderr and nonzero exit, spawns detached with no stdin', async () => {
        const pending = bash();
        child.stdout.write(Buffer.from('中文 output'));
        child.stderr.write(Buffer.from('diagnostic'));
        child.emit('close', 3, null);
        expect(await pending).toEqual({ stdout: '中文 output', stderr: 'diagnostic', exitCode: 3 });
        expect(spawn).toHaveBeenCalledWith('/fake/bash', ['-c', `cd "${cwd}" && printf test`], {
            cwd,
            detached: true,
            windowsHide: true,
            windowsVerbatimArguments: undefined,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stderr.destroyed).toBe(true);
        await flushAudit();
        const entry = JSON.parse(String(audit.append.mock.calls[0]?.[1]));
        expect(entry).toMatchObject({ exitCode: 3, timedOut: false, stdoutBytes: 13, stderrBytes: 10 });
        expect(entry.ts).toMatch(/Z$/);
        expect(tools.Bash!.description).toContain('/extra/project');
    });

    it.each([
        ['SIGKILL', 137],
        ['SIGTERM', 143],
        ['SIGINT', 1],
        [null, 0]
    ])('maps null exit code and signal %s to %s', async (signal, code) => {
        const pending = bash();
        child.emit('close', null, signal);
        expect((await pending).exitCode).toBe(code);
    });

    it('reports a synchronous spawn failure without leaving a timer', async () => {
        vi.useFakeTimers();
        vi.mocked(spawn).mockImplementationOnce(() => {
            throw new Error('invalid spawn options');
        });
        expect(await bash()).toEqual({ stdout: '', stderr: '无法启动 shell: invalid spawn options', exitCode: 127 });
        await flushAudit();
        expect(audit.append.mock.calls[0]?.[1]).toContain('spawnError');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('formats non-Error synchronous failures', async () => {
        vi.mocked(spawn).mockImplementationOnce(() => {
            throw 'spawn failed';
        });
        expect((await bash()).stderr).toBe('无法启动 shell: spawn failed');
    });

    it('settles once on asynchronous ENOENT and ignores later close', async () => {
        const pending = bash();
        child.emit('error', new Error('ENOENT fake shell'));
        child.emit('close', 0, null);
        expect(await pending).toEqual({ stdout: '', stderr: '无法执行命令: ENOENT fake shell', exitCode: 127 });
        await flushAudit();
        expect(audit.append).toHaveBeenCalledTimes(1);
    });

    it('caps both byte streams while still consuming chunks and then applies tool truncation', async () => {
        const pending = bash('x'.repeat(350));
        const limit = 10 * 1024 * 1024;
        child.stdout.write(Buffer.alloc(limit - 2, 'a'));
        child.stdout.write(Buffer.from('12345'));
        child.stdout.write(Buffer.from('discarded'));
        child.stderr.write(Buffer.alloc(limit, 'b'));
        child.stderr.write(Buffer.from('discarded'));
        child.emit('close', 0, null);
        const result = await pending;
        expect(result.stdout).toMatch(/^a{30000}\n\n\[stdout truncated:/);
        expect(result.stderr).toMatch(/^b{30000}\n\n\[stderr truncated:/);
        await flushAudit();
        expect(JSON.parse(String(audit.append.mock.calls[0]?.[1]))).toMatchObject({
            stdoutBytes: limit,
            stderrBytes: limit,
            stdoutTruncated: true,
            stderrTruncated: true
        });
    });

    it('kills the POSIX group on timeout, preserving stderr and overriding close status', async () => {
        vi.useFakeTimers();
        const pending = bash();
        child.stderr.write(Buffer.from('before timeout'));
        await vi.advanceTimersByTimeAsync(100);
        expect(process.kill).toHaveBeenCalledWith(-424242, 'SIGKILL');
        child.emit('close', 0, null);
        expect(await pending).toEqual({
            stdout: '',
            stderr: 'before timeout\n[命令执行超过 100ms，已被强制结束]',
            exitCode: 124
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('uses the grace timer if close never arrives and tolerates missing pid', async () => {
        child.pid = undefined;
        vi.useFakeTimers();
        const pending = bash();
        await vi.advanceTimersByTimeAsync(2100);
        expect(await pending).toEqual({ stdout: '', stderr: '[命令执行超过 100ms，已被强制结束]', exitCode: 124 });
        expect(process.kill).not.toHaveBeenCalled();
        child.emit('close', 0, null);
        await flushAudit();
        expect(audit.append).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])('falls back to child.kill and tolerates exited child=%s', async (throws) => {
        vi.mocked(process.kill).mockImplementation(() => {
            throw new Error('ESRCH');
        });
        if (throws)
            child.kill.mockImplementation(() => {
                throw new Error('already exited');
            });
        vi.useFakeTimers();
        const pending = bash();
        await vi.advanceTimersByTimeAsync(2100);
        expect((await pending).exitCode).toBe(124);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('records current abort behavior: wrapper ignores the supplied abortSignal until child exits', async () => {
        const controller = new AbortController();
        controller.abort();
        const pending = bash('fake command only', controller.signal);
        expect(spawn).toHaveBeenCalledTimes(1);
        child.stdout.write(Buffer.from('completed despite abort'));
        child.emit('close', 0, null);
        expect((await pending).stdout).toBe('completed despite abort');
        expect(process.kill).not.toHaveBeenCalled();
    });

    it('keeps successful commands successful if the fake audit sink rejects', async () => {
        audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
        let pending = bash();
        child.emit('close', 0, null);
        expect((await pending).exitCode).toBe(0);
        await flushAudit();
        expect(audit.warn).toHaveBeenCalledWith('审计日志写入失败', expect.any(Object));
        child = new FakeChild();
        vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
        pending = bash('second command');
        child.emit('close', 0, null);
        await pending;
        await flushAudit();
        expect(audit.append).toHaveBeenCalledTimes(2);
        expect(audit.mkdir).toHaveBeenCalledTimes(1);
    });
});

describe('Windows Bash.execute adaptation through actual Windows dependencies', () => {
    async function windowsTools(shell: string, probeOutput = '7\nFullLanguage') {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('ZHUIXUN_SHELL', shell);
        vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
            const callback = args.at(-1) as (err: Error | null, stdout: Buffer) => void;
            callback(null, Buffer.from(String(args[0]).endsWith('reg.exe') ? 'OEMCP REG_SZ 936' : probeOutput));
            return {} as ReturnType<typeof execFile>;
        });
        tools = await createShellTools(cwd, { primaryDir: cwd });
    }

    it.each([
        ['7\nFullLanguage', 'PowerShell 7', '支持 `&&` / `||`'],
        ['5\nFullLanguage', 'PowerShell 5（Windows PowerShell）', '**不支持 `&&` / `||`**'],
        ['bad\nFullLanguage', '版本未知', '**不支持 `&&` / `||`**']
    ])('strips bash-tool cd prefix and sends stdin base64 for %s', async (out, label, syntax) => {
        await windowsTools('powershell.exe', out);
        const pending = bash('Write-Output "中文"');
        const call = vi.mocked(spawn).mock.calls[0]!;
        expect(call[0]).toBe('powershell.exe');
        expect(call[2]).toMatchObject({ detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
        expect(child.stdin.read()?.toString()).toBe(Buffer.from('Write-Output "中文"').toString('base64'));
        child.stdin.emit('error', new Error('EPIPE'));
        child.stdout.write(Buffer.from('UTF-8 中文\r\n'));
        child.stdout.write(iconv.encode('旧程序中文', 'cp936'));
        child.emit('close', 0, null);
        expect((await pending).stdout).toBe('UTF-8 中文\n旧程序中文');
        expect(tools.Bash!.description).toContain(label);
        expect(tools.Bash!.description).toContain(syntax);
        expect(tools.Bash!.description).toContain('Get-ChildItem -Force');
        expect(tools.Bash!.description).not.toContain('ls -la');
    });

    it('runs cmd using verbatim arguments and no stdin', async () => {
        await windowsTools('cmd.exe');
        const pending = bash('dir');
        expect(spawn).toHaveBeenCalledWith(
            'cmd.exe',
            ['/d', '/s', '/c', '"chcp 65001 >nul & dir"'],
            expect.objectContaining({ windowsVerbatimArguments: true })
        );
        child.emit('close', 0, null);
        await pending;
        expect(tools.Bash!.description).toContain('cmd.exe');
        expect(tools.Bash!.description).toContain('dir /s /b *.md');
    });

    it('keeps POSIX cd prefix for Git Bash on Windows', async () => {
        await windowsTools('C:\\Git\\bash.exe');
        const pending = bash('printf hi');
        expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['-c', `cd "${cwd}" && printf hi`]);
        child.emit('close', 0, null);
        await pending;
        expect(tools.Bash!.description).toContain('真实** POSIX shell');
    });

    it.each(['success', 'error-event', 'throw'])('uses taskkill /T on timeout with %s fallback', async (mode) => {
        await windowsTools('cmd.exe');
        vi.stubEnv('SystemRoot', mode === 'success' ? 'D:\\Win' : '');
        const taskkill = new FakeChild();
        vi.mocked(spawn)
            .mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)
            .mockImplementationOnce(() => {
                if (mode === 'throw') throw new Error('taskkill not found');
                return taskkill as unknown as ReturnType<typeof spawn>;
            });
        vi.useFakeTimers();
        const pending = bash();
        await vi.advanceTimersByTimeAsync(100);
        expect(vi.mocked(spawn).mock.calls[1]).toEqual([
            `${mode === 'success' ? 'D:\\Win' : 'C:\\Windows'}\\System32\\taskkill.exe`,
            ['/PID', '424242', '/T', '/F'],
            { stdio: 'ignore', windowsHide: true }
        ]);
        if (mode === 'error-event') taskkill.emit('error', new Error('failed'));
        if (mode !== 'success') expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        child.emit('close', null, 'SIGKILL');
        expect((await pending).exitCode).toBe(124);
        taskkill.stdout.destroy();
        taskkill.stderr.destroy();
        taskkill.stdin.destroy();
    });
});
