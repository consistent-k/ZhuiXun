import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type * as NodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEditSearchTools } from '@/agent/tools/edit-search-tools';
import { MAX_OUTPUT_LENGTH } from '@/config/shell';

vi.mock('node:module', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeModule>();
    return { ...actual, createRequire: vi.fn(() => rgModule.load) };
});
const rgModule = vi.hoisted(() => ({ load: vi.fn(() => ({ rgPath: '/fake/bundled-rg' })) }));
const options = { toolCallId: 'search-call', messages: [], context: {} };
let root: string;
let tools: ToolSet;

class FakeRg extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill = vi.fn(() => {
        queueMicrotask(() => this.emit('close', null));
        return true;
    });
}

function fakeSpawn(events?: (child: FakeRg) => void) {
    const child = new FakeRg();
    vi.mocked(spawn).mockImplementationOnce(() => {
        if (events) queueMicrotask(() => events(child));
        return child as unknown as ReturnType<typeof spawn>;
    });
    return child;
}

async function execute(name: string, input: unknown) {
    return tools[name].execute!(input, options);
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-search-unit-'));
    tools = createEditSearchTools(root);
    rgModule.load.mockReset().mockReturnValue({ rgPath: '/fake/bundled-rg' });
    vi.mocked(spawn).mockClear();
});
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
});

describe('agent Edit execute', () => {
    it('records pre-state before writing an exact unique replacement', async () => {
        const target = path.join(root, 'document.txt');
        await fs.writeFile(target, 'before\nold value\nafter\n');
        const record = vi.fn(async (file: string) => {
            expect(file).toBe(target);
            expect(await fs.readFile(file, 'utf8')).toBe('before\nold value\nafter\n');
        });
        tools = createEditSearchTools(root, { record });
        expect(
            await execute('Edit', { file_path: 'document.txt', old_string: 'old value', new_string: 'new value' })
        ).toEqual({ success: true, path: target, replacements: 1 });
        expect(record).toHaveBeenCalledOnce();
        expect(await fs.readFile(target, 'utf8')).toBe('before\nnew value\nafter\n');
    });

    it('replaces every literal match when requested, including dollar-sign replacement text', async () => {
        const target = path.join(root, 'many.txt');
        await fs.writeFile(target, 'a.b a.b a.b');
        expect(
            await execute('Edit', { file_path: target, old_string: 'a.b', new_string: '$&', replace_all: true })
        ).toEqual({ success: true, path: target, replacements: 3 });
        expect(await fs.readFile(target, 'utf8')).toBe('$& $& $&');
    });

    it.each([
        ['', 'new', '不能为空'],
        ['same', 'same', '相同'],
        ['absent', 'new', '未在文件中找到'],
        ['same', 'new', '命中 2 处']
    ])('rejects invalid/ambiguous edit %s -> %s before checkpoint or write', async (old_string, new_string, error) => {
        const target = path.join(root, 'original.txt');
        await fs.writeFile(target, 'same same');
        const record = vi.fn();
        tools = createEditSearchTools(root, { record });
        await expect(execute('Edit', { file_path: 'original.txt', old_string, new_string })).rejects.toThrow(error);
        expect(record).not.toHaveBeenCalled();
        expect(await fs.readFile(target, 'utf8')).toBe('same same');
    });

    it('refuses protected paths and reports a missing file with the original cause', async () => {
        await expect(
            execute('Edit', { file_path: '.git/config', old_string: 'old', new_string: 'new' })
        ).rejects.toThrow('拒绝写入受保护路径');
        await expect(
            execute('Edit', { file_path: 'missing', old_string: 'old', new_string: 'new' })
        ).rejects.toMatchObject({
            message: `File not found: ${path.join(root, 'missing')}`,
            cause: { code: 'ENOENT' }
        });
    });

    it('propagates non-ENOENT read failures and checkpoint failure without changing content', async () => {
        const readError = Object.assign(new Error('denied'), { code: 'EACCES' });
        vi.spyOn(fs, 'readFile').mockRejectedValueOnce(readError);
        await expect(execute('Edit', { file_path: 'document', old_string: 'a', new_string: 'b' })).rejects.toBe(
            readError
        );
        const target = path.join(root, 'document');
        await fs.writeFile(target, 'a');
        const record = vi.fn().mockRejectedValueOnce(new Error('snapshot failed'));
        tools = createEditSearchTools(root, { record });
        await expect(execute('Edit', { file_path: 'document', old_string: 'a', new_string: 'b' })).rejects.toThrow(
            'snapshot failed'
        );
        expect(await fs.readFile(target, 'utf8')).toBe('a');
    });
});

describe('agent Grep execute with fake ripgrep process', () => {
    it('builds safe content-mode argv without a shell and reports matches', async () => {
        fakeSpawn((child) => {
            child.stdout.emit('data', Buffer.from('code.ts:1:needle\n'));
            child.emit('close', 0);
        });
        expect(
            await execute('Grep', {
                pattern: '-dangerous; pattern',
                path: 'src',
                glob: '*.ts',
                ignoreCase: true,
                contextLines: 2,
                maxMatches: 3
            })
        ).toEqual({ matched: true, output: 'code.ts:1:needle\n', truncated: false });
        expect(spawn).toHaveBeenLastCalledWith(
            expect.any(String),
            [
                '--color',
                'never',
                '-i',
                '--glob',
                '*.ts',
                '--no-heading',
                '-n',
                '-m',
                '3',
                '-C',
                '2',
                '-e',
                '-dangerous; pattern',
                path.join(root, 'src')
            ],
            { cwd: root }
        );
    });

    it('appends policy exclude globs after the model glob so they cannot be overridden', async () => {
        tools = createEditSearchTools(root, undefined, ['!**/.env', '!**/*.pem']);
        fakeSpawn((child) => child.emit('close', 1));
        await execute('Grep', { pattern: 'k', glob: '.env', outputMode: 'files' });
        expect(vi.mocked(spawn).mock.lastCall?.[1]).toEqual([
            '--color',
            'never',
            '--glob',
            '.env',
            '--glob',
            '!**/.env',
            '--glob',
            '!**/*.pem',
            '-l',
            '-e',
            'k',
            root
        ]);
    });

    it.each([
        [undefined, ['--no-heading', '-n', '-m', '200']],
        ['files', ['-l']],
        ['count', ['-c']]
    ] as const)('maps output mode %s and rg no-match exit 1', async (outputMode, flags) => {
        fakeSpawn((child) => child.emit('close', 1));
        expect(await execute('Grep', { pattern: 'missing', outputMode, contextLines: 0 })).toEqual({
            matched: false,
            output: '（无匹配）',
            truncated: false
        });
        expect(spawn).toHaveBeenLastCalledWith(
            expect.any(String),
            ['--color', 'never', ...flags, '-e', 'missing', root],
            { cwd: root }
        );
    });

    it('retains nonempty output on no-match and handles null exit code', async () => {
        for (const code of [1, null]) {
            fakeSpawn((child) => {
                child.stdout.emit('data', Buffer.from('partial'));
                child.emit('close', code);
            });
            expect(await execute('Grep', { pattern: 'test' })).toEqual({
                matched: false,
                output: 'partial',
                truncated: false
            });
        }
    });

    it.each(['bad pattern', ''])('reports exit 2 with stderr %s', async (stderr) => {
        fakeSpawn((child) => {
            child.stderr.emit('data', Buffer.from(stderr));
            child.emit('close', 2);
        });
        await expect(execute('Grep', { pattern: '[' })).rejects.toThrow(`ripgrep 检索出错：${stderr || '未知错误'}`);
    });

    it('propagates spawn errors and clears the timeout', async () => {
        vi.useFakeTimers();
        const failure = new Error('fake ENOENT');
        const child = fakeSpawn();
        const result = execute('Grep', { pattern: 'test' });
        child.emit('error', failure);
        await expect(result).rejects.toBe(failure);
        expect(vi.getTimerCount()).toBe(0);
        expect(child.kill).not.toHaveBeenCalled();
    });

    it('kills on output overflow, ignores later chunks and accepts a killed/error exit for truncated output', async () => {
        const child = fakeSpawn((proc) => {
            proc.stdout.emit('data', Buffer.from('x'.repeat(MAX_OUTPUT_LENGTH + 1)));
            proc.stdout.emit('data', Buffer.from('must not be appended'));
            proc.emit('close', 2);
        });
        expect(await execute('Grep', { pattern: 'x' })).toEqual({
            matched: false,
            output: `${'x'.repeat(MAX_OUTPUT_LENGTH)}\n...（输出已截断）`,
            truncated: true
        });
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('kills on hard timeout without waiting for any real process', async () => {
        vi.useFakeTimers();
        const child = fakeSpawn();
        const result = execute('Grep', { pattern: 'stuck' });
        const rejection = expect(result).rejects.toThrow('Grep 超时（> 30000ms）');
        await vi.advanceTimersByTimeAsync(30000);
        await rejection;
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('uses an existing packaged rg path and caches it', async () => {
        const fakePath = path.join(root, 'not-an-executable');
        await fs.writeFile(fakePath, 'fake');
        vi.stubEnv('ZHUIXUN_RG_PATH', fakePath);
        vi.resetModules();
        tools = (await import('@/agent/tools/edit-search-tools')).createEditSearchTools(root);
        for (let index = 0; index < 2; index++) {
            fakeSpawn((child) => child.emit('close', 1));
            await execute('Grep', { pattern: 'test' });
            expect(spawn).toHaveBeenLastCalledWith(fakePath, expect.any(Array), { cwd: root });
            vi.stubEnv('ZHUIXUN_RG_PATH', '/missing/new-rg');
        }
        expect(rgModule.load).not.toHaveBeenCalled();
    });

    it.each(['valid', 'missing', 'throws'] as const)(
        'resolves dev rg dependency result %s with system fallback',
        async (variant) => {
            vi.stubEnv('ZHUIXUN_RG_PATH', '/not-present/unit-rg');
            if (variant === 'missing') rgModule.load.mockReturnValue({} as { rgPath: string });
            if (variant === 'throws')
                rgModule.load.mockImplementation(() => {
                    throw new Error('module absent');
                });
            vi.resetModules();
            tools = (await import('@/agent/tools/edit-search-tools')).createEditSearchTools(root);
            fakeSpawn((child) => child.emit('close', 1));
            await execute('Grep', { pattern: 'test' });
            expect(rgModule.load).toHaveBeenCalledWith('@vscode/ripgrep');
            expect(spawn).toHaveBeenLastCalledWith(variant === 'valid' ? '/fake/bundled-rg' : 'rg', expect.any(Array), {
                cwd: root
            });
        }
    );
});

describe('agent Glob / LS execute', () => {
    it('glob returns absolute paths newest first and resolves an optional search root', async () => {
        await fs.mkdir(path.join(root, 'src'));
        const older = path.join(root, 'src/old.ts');
        const newer = path.join(root, 'src/new.ts');
        await fs.writeFile(older, 'old');
        await fs.writeFile(newer, 'new');
        await fs.utimes(older, 1, 1);
        await fs.utimes(newer, 2, 2);
        expect(await execute('Glob', { pattern: '*.ts', path: 'src' })).toEqual({
            count: 2,
            truncated: false,
            files: [newer, older]
        });
        expect(await execute('Glob', { pattern: '*.missing' })).toEqual({ count: 0, truncated: false, files: [] });
    });

    it('glob tolerates a file vanishing before stat and caps huge result sets', async () => {
        const glob = vi.spyOn(fs, 'glob');
        glob.mockImplementationOnce(async function* () {
            yield 'vanished';
            yield 'present';
        } as typeof fs.glob);
        vi.spyOn(fs, 'stat')
            .mockRejectedValueOnce(new Error('vanished'))
            .mockResolvedValueOnce({ mtimeMs: 1 } as Awaited<ReturnType<typeof fs.stat>>);
        expect(await execute('Glob', { pattern: '*' })).toEqual({
            count: 2,
            truncated: false,
            files: [path.join(root, 'present'), path.join(root, 'vanished')]
        });
        glob.mockImplementationOnce(async function* () {
            for (let index = 0; index < 1005; index++) yield `file-${index}`;
        } as typeof fs.glob);
        vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 1 } as Awaited<ReturnType<typeof fs.stat>>);
        const result = await execute('Glob', { pattern: '*' });
        expect(result).toMatchObject({ count: 1000, truncated: true });
        expect(result).toHaveProperty(
            'files',
            Array.from({ length: 1000 }, (_, index) => path.join(root, `file-${index}`))
        );
    });

    it('LS categorizes directories/files/symlinks, sorts directories first and optionally hides dot entries', async () => {
        await fs.mkdir(path.join(root, 'z-dir'));
        await fs.mkdir(path.join(root, 'a-dir'));
        await fs.writeFile(path.join(root, 'b-file'), 'synthetic');
        await fs.writeFile(path.join(root, 'a-file'), 'synthetic');
        await fs.writeFile(path.join(root, '.hidden'), 'synthetic');
        await fs.symlink('b-file', path.join(root, 'link'));
        const listed = await execute('LS', { path: '.', ignoreHidden: true });
        expect(listed).toEqual({
            path: root,
            entries: [
                { name: 'a-dir', type: 'dir' },
                { name: 'z-dir', type: 'dir' },
                { name: 'a-file', type: 'file' },
                { name: 'b-file', type: 'file' },
                { name: 'link', type: 'symlink' }
            ]
        });
        expect(await execute('LS', { path: '.' })).toMatchObject({
            entries: expect.arrayContaining([{ name: '.hidden', type: 'file' }])
        });
    });

    it('LS reports missing directory with cause and propagates other filesystem errors', async () => {
        await expect(execute('LS', { path: 'missing' })).rejects.toMatchObject({
            message: `目录不存在：${path.join(root, 'missing')}`,
            cause: { code: 'ENOENT' }
        });
        const error = Object.assign(new Error('denied'), { code: 'EACCES' });
        vi.spyOn(fs, 'readdir').mockRejectedValueOnce(error);
        await expect(execute('LS', { path: '.' })).rejects.toBe(error);
    });
});
