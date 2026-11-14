import { execFile } from 'node:child_process';
import fs from 'node:fs';

import iconv from 'iconv-lite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/logging/index', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const exec = vi.mocked(execFile);
let probe: (bin: string, args: readonly string[]) => string | undefined;

beforeEach(() => {
    vi.resetModules();
    exec.mockReset();
    vi.stubEnv('ZHUIXUN_SHELL', '');
    vi.stubEnv('PATH', '');
    vi.stubEnv('ProgramFiles', '');
    vi.stubEnv('ProgramW6432', '');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('windir', '');
    vi.stubEnv('ComSpec', '');
    probe = () => undefined;
    exec.mockImplementation((...args: unknown[]) => {
        const [bin, argv] = args as [string, string[]];
        const callback = args.at(-1) as (err: Error | null, stdout: Buffer) => void;
        const output = probe(bin, argv);
        callback(output === undefined ? new Error('probe unavailable') : null, Buffer.from(output ?? '', 'latin1'));
        return {} as ReturnType<typeof execFile>;
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
});

afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

const load = () => import('@/agent/tools/windows-shell');

describe('Windows shell resolution with fake execFile', () => {
    it.each([
        ['C:\\Git\\bash.exe', 'posix'],
        ['C:\\Windows\\cmd.exe', 'cmd']
    ])('uses non-PowerShell override %s without probing', async (bin, kind) => {
        vi.stubEnv('ZHUIXUN_SHELL', bin);
        const { resolveWindowsShell } = await load();
        expect(await resolveWindowsShell()).toEqual({ bin, kind });
        expect(exec).not.toHaveBeenCalled();
    });

    it('caches by override and re-probes when override changes', async () => {
        vi.stubEnv('ZHUIXUN_SHELL', 'pwsh.exe');
        probe = () => '7\r\nFullLanguage\r\n';
        const { resolveWindowsShell } = await load();
        const first = resolveWindowsShell();
        expect(resolveWindowsShell()).toBe(first);
        expect(await first).toEqual({ bin: 'pwsh.exe', kind: 'powershell', psMajor: 7 });
        vi.stubEnv('ZHUIXUN_SHELL', 'powershell.exe');
        probe = () => '5\nConstrainedLanguage';
        expect(await resolveWindowsShell()).toEqual({ bin: 'powershell.exe', kind: 'powershell', psMajor: 5 });
        expect(exec).toHaveBeenCalledTimes(2);
        expect(exec.mock.calls[0]?.[2]).toEqual({ timeout: 15_000, windowsHide: true, encoding: 'buffer' });
    });

    it('keeps an explicit PowerShell even if probe fails', async () => {
        vi.stubEnv('ZHUIXUN_SHELL', 'pwsh');
        const { resolveWindowsShell } = await load();
        expect(await resolveWindowsShell()).toEqual({ bin: 'pwsh', kind: 'powershell', psMajor: undefined });
    });

    it.each(['not-a-number\nFullLanguage', '', '7'])('tolerates incomplete explicit probe %j', async (out) => {
        vi.stubEnv('ZHUIXUN_SHELL', 'pwsh');
        probe = () => out;
        const { resolveWindowsShell } = await load();
        expect((await resolveWindowsShell()).kind).toBe('powershell');
    });

    it('prioritizes PATH pwsh, skips failures and deduplicates candidates', async () => {
        vi.stubEnv('PATH', ';"C:\\bin";c:\\BIN;C:\\other');
        vi.stubEnv('ProgramW6432', 'C:\\Program Files');
        vi.stubEnv('ProgramFiles', 'C:\\Program Files');
        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const text = String(p).toLowerCase();
            return (
                text === 'c:\\bin\\pwsh.exe' || text.includes('\\powershell\\7\\') || text.includes('windowspowershell')
            );
        });
        probe = (bin) => (bin === 'C:\\bin\\pwsh.exe' ? undefined : '7\nFullLanguage');
        const { resolveWindowsShell } = await load();
        expect(await resolveWindowsShell()).toEqual({
            bin: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
            kind: 'powershell',
            psMajor: 7
        });
        expect(exec).toHaveBeenCalledTimes(2);
        expect(exec.mock.calls[0]?.[0]).toBe('C:\\bin\\pwsh.exe');
    });

    it('selects Windows PowerShell if pwsh is absent', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => String(p).includes('WindowsPowerShell'));
        probe = () => '5\nFullLanguage';
        const { resolveWindowsShell } = await load();
        expect(await resolveWindowsShell()).toEqual({
            bin: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            kind: 'powershell',
            psMajor: 5
        });
    });

    it('falls directly to ComSpec on constrained language rather than trying another shell', async () => {
        vi.stubEnv('PATH', 'C:\\bin');
        vi.stubEnv('ComSpec', 'D:\\cmd.exe');
        vi.mocked(fs.existsSync).mockReturnValue(true);
        probe = () => '7\nConstrainedLanguage';
        const { resolveWindowsShell } = await load();
        expect(await resolveWindowsShell()).toEqual({ bin: 'D:\\cmd.exe', kind: 'cmd' });
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('uses windir and then default Windows root when no candidates exist', async () => {
        vi.stubEnv('SystemRoot', '');
        vi.stubEnv('windir', 'D:\\Win');
        const { resolveWindowsShell } = await load();
        expect(await resolveWindowsShell()).toEqual({ bin: 'D:\\Win\\System32\\cmd.exe', kind: 'cmd' });
        vi.resetModules();
        vi.stubEnv('windir', '');
        expect(await (await load()).resolveWindowsShell()).toEqual({
            bin: 'C:\\Windows\\System32\\cmd.exe',
            kind: 'cmd'
        });
    });
});

describe('Windows output encoding and invocation', () => {
    it('probes OEMCP once and decodes mixed UTF-8/OEM lines, ANSI and CRLF', async () => {
        probe = () => 'OEMCP    REG_SZ    936\r\n';
        const { createWindowsDecoder } = await load();
        const [decode, again] = await Promise.all([createWindowsDecoder(), createWindowsDecoder()]);
        const bytes = Buffer.concat([
            Buffer.from('\u001b[31m中文 UTF-8\u001b[0m\r\n'),
            iconv.encode('中文 OEM\r\n最后一行', 'cp936')
        ]);
        expect(decode(bytes)).toBe('中文 UTF-8\n中文 OEM\n最后一行');
        expect(again(Buffer.from('ok\r\n'))).toBe('ok\n');
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('falls back to localized chcp output when registry is unavailable', async () => {
        probe = (_bin, args) => (args.includes('chcp') ? 'Active code page: 850\r\n' : undefined);
        const { createWindowsDecoder } = await load();
        expect((await createWindowsDecoder())(iconv.encode('café\n', 'cp850'))).toBe('café\n');
        expect(exec).toHaveBeenCalledTimes(2);
    });

    it('falls back to chcp if registry output lacks OEMCP', async () => {
        probe = (_bin, args) => (args.includes('chcp') ? '当前代码页: 932' : 'unrecognized');
        const { createWindowsDecoder } = await load();
        expect((await createWindowsDecoder())(iconv.encode('日本語', 'cp932'))).toBe('日本語');
    });

    it.each([undefined, 65001, 99999, 0])('uses permissive UTF-8 without a usable legacy code page %s', async (cp) => {
        const { buildDecoder } = await load();
        const decode = buildDecoder(cp);
        expect(decode(Buffer.from('valid\r\n'))).toBe('valid\n');
        expect(decode(Buffer.from([0xff, 0x0a, 0xff]))).toBe('�\n�');
        expect(decode(Buffer.alloc(0))).toBe('');
    });

    it('tolerates unsuccessful code page probes', async () => {
        const { createWindowsDecoder } = await load();
        expect((await createWindowsDecoder())(Buffer.from([0xff]))).toBe('�');
        expect(exec).toHaveBeenCalledTimes(2);
    });

    it('prewarms only on Windows', async () => {
        const { prewarmWindowsShell, createWindowsDecoder, resolveWindowsShell } = await load();
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        prewarmWindowsShell();
        expect(exec).not.toHaveBeenCalled();
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        prewarmWindowsShell();
        await Promise.all([createWindowsDecoder(), resolveWindowsShell()]);
        expect(exec).toHaveBeenCalledTimes(2);
    });

    it('builds PowerShell stdin base64 without interpolating command text', async () => {
        const { buildWindowsInvocation } = await load();
        const command = 'Write-Output "中文"; node -e \'console.log("a\\\\b")\'';
        const invocation = buildWindowsInvocation({ bin: 'pwsh', kind: 'powershell' }, command);
        expect(Buffer.from(invocation.stdin!, 'base64').toString('utf8')).toBe(command);
        expect(invocation.args).toContain('-NonInteractive');
        expect(invocation.args).toContain('Bypass');
        const bootstrap = invocation.args.at(-1)!;
        expect(bootstrap).not.toContain('"');
        expect(bootstrap).not.toContain(command);
        expect(bootstrap).toContain('Invoke-Expression');
        expect(bootstrap).toContain('$Error.Count -eq 0');
        expect(bootstrap).toContain('exit $global:LASTEXITCODE');
    });

    it('builds cmd verbatim quoting and POSIX args', async () => {
        const { buildWindowsInvocation } = await load();
        expect(buildWindowsInvocation({ bin: 'cmd', kind: 'cmd' }, 'echo "a" & dir')).toEqual({
            args: ['/d', '/s', '/c', '"chcp 65001 >nul & echo "a" & dir"'],
            verbatim: true
        });
        expect(buildWindowsInvocation({ bin: 'bash', kind: 'posix' }, 'printf x')).toEqual({
            args: ['-c', 'printf x']
        });
    });
});
