import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ShellTools from '@/agent/tools/shell-tools';
import type * as ShellConfig from '@/config/shell';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => log }));
vi.mock('@/config/shell', async (importOriginal) => {
    const actual = await importOriginal<typeof ShellConfig>();
    return { ...actual, WORKSPACE_DIR: path.join(process.env.ZHUIXUN_TEST_HOME!, 'files-workspace') };
});
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    // 文件操作仍走真实临时 FS；唯一可追加的审计落点完全替换为内存 sink。
    const appendFile = vi.fn(async () => undefined);
    const mkdir = (...args: Parameters<typeof actual.mkdir>) =>
        String(args[0]).endsWith(`${path.sep}.zhuixun${path.sep}audit`)
            ? Promise.resolve(undefined)
            : actual.mkdir(...args);
    return { ...actual, appendFile, mkdir, default: { ...actual, appendFile, mkdir } };
});

const toolOptions = { toolCallId: 'shell-files', messages: [], context: undefined };
let root: string;
let project: string;
let skills: string;
let tools: ToolSet;
let createShellTools: typeof ShellTools.createShellTools;
let isProtectedWrite: typeof ShellTools.isProtectedWrite;
let workspace: string;

async function execute(name: string, input: unknown) {
    return tools[name]!.execute!(input, toolOptions);
}

async function put(relative: string, content = relative) {
    const target = path.join(root, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
    return target;
}

beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('ZHUIXUN_SHELL', '/fake/bash');
    root = await fsp.mkdtemp(path.join(process.env.ZHUIXUN_TEST_HOME!, 'shell-files-'));
    project = path.join(root, 'project');
    skills = path.join(root, 'skills');
    await Promise.all([fsp.mkdir(project), fsp.mkdir(skills)]);
    ({ createShellTools, isProtectedWrite } = await import('@/agent/tools/shell-tools'));
    workspace = (await import('@/config/shell')).WORKSPACE_DIR;
    await fsp.rm(workspace, { recursive: true, force: true });
    tools = await createShellTools(skills, { primaryDir: project });
    vi.clearAllMocks();
});

afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(workspace, { recursive: true, force: true });
});

describe('actual Read/Write.execute on temporary files', () => {
    it('resolves relative/absolute paths and creates parent directories without a checkpoint', async () => {
        expect(await execute('Write', { path: 'nested/a.txt', content: 'first\n中文' })).toEqual({ success: true });
        expect(await execute('Read', { path: 'nested/a.txt' })).toEqual({ content: 'first\n中文' });
        expect(await execute('Read', { path: path.join(project, 'nested/a.txt') })).toEqual({ content: 'first\n中文' });
        expect(await fsp.readFile(path.join(project, 'nested/a.txt'), 'utf8')).toBe('first\n中文');
        expect(spawn).not.toHaveBeenCalled();
    });

    it('reports ENOENT and other real FS read failures with distinct error messages', async () => {
        await expect(execute('Read', { path: 'missing' })).rejects.toThrow('File not found:');
        // Linux/macOS 对目录 readFile 抛 EISDIR；无需 mock 被测 sandbox。
        await expect(execute('Read', { path: project })).rejects.toThrow('Failed to read file:');
    });

    it('awaits checkpoint before writes and does not mutate when an injected recorder rejects', async () => {
        const target = await put('project/original.txt', 'before');
        const record = vi.fn(async (file: string) => {
            expect(file).toBe(target);
            expect(await fsp.readFile(file, 'utf8')).toBe('before');
            throw new Error('checkpoint failed');
        });
        tools = await createShellTools(skills, { primaryDir: project, checkpoint: { record } });
        await expect(execute('Write', { path: 'original.txt', content: 'after' })).rejects.toThrow('checkpoint failed');
        expect(await fsp.readFile(target, 'utf8')).toBe('before');
    });

    it('snapshots only the original state and rewinds actual overwritten/new files', async () => {
        const { createCheckpointStore } = await import('@/modules/conversations');
        const store = createCheckpointStore(path.join(root, 'sessions'));
        const recorder = store.recorder('shell-session', 'turn-1');
        const before = await put('project/original.txt', 'original bytes');
        tools = await createShellTools(skills, { primaryDir: project, checkpoint: recorder });
        await execute('Write', { path: 'original.txt', content: 'first overwrite' });
        await execute('Write', { path: before, content: 'second overwrite' });
        await execute('Write', { path: 'new/note.md', content: 'new content' });
        expect(await fsp.readFile(before, 'utf8')).toBe('second overwrite');
        const result = await store.rewind('shell-session', 'turn-1');
        expect(result).toEqual({ restored: [before], deleted: [path.join(project, 'new/note.md')], skipped: [] });
        expect(await fsp.readFile(before, 'utf8')).toBe('original bytes');
        await expect(fsp.stat(path.join(project, 'new/note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('propagates FS write failures after recording pre-state', async () => {
        await put('project/not-directory', 'file');
        const record = vi.fn(async () => undefined);
        tools = await createShellTools(skills, { primaryDir: project, checkpoint: { record } });
        await expect(execute('Write', { path: 'not-directory/child.txt', content: 'never written' })).rejects.toThrow();
        expect(record).toHaveBeenCalledWith(path.join(project, 'not-directory/child.txt'));
    });

    it.each(['.git/config', 'nested/.git/hooks/pre-commit', '.ssh/authorized_keys', '../project/.git/config'])(
        'rejects protected path %s before checkpoint',
        async (relative) => {
            const record = vi.fn(async () => undefined);
            tools = await createShellTools(skills, { primaryDir: project, checkpoint: { record } });
            await expect(execute('Write', { path: relative, content: 'bad' })).rejects.toThrow('拒绝写入受保护路径');
            expect(record).not.toHaveBeenCalled();
            await expect(fsp.stat(path.resolve(project, relative))).rejects.toMatchObject({ code: 'ENOENT' });
        }
    );

    it('protects home data root and descendants but does not overmatch sibling names', async () => {
        const protectedRoot = path.join(os.homedir(), '.zhuixun');
        for (const target of [
            protectedRoot,
            path.join(protectedRoot, 'settings.json'),
            path.join(os.homedir(), '.ssh', 'key')
        ]) {
            expect(isProtectedWrite(target)).toBe(true);
            await expect(execute('Write', { path: target, content: 'bad' })).rejects.toThrow('拒绝写入受保护路径');
        }
        for (const target of [
            path.join(project, '.gitignore'),
            path.join(project, '.ssh-copy/file'),
            path.join(os.homedir(), '.zhuixun-copy/file')
        ]) {
            expect(isProtectedWrite(target)).toBe(false);
        }
    });

    it('does not impose a write-root restriction on normal absolute paths', async () => {
        const outside = path.join(root, 'additional/result.txt');
        await execute('Write', { path: outside, content: 'allowed absolute' });
        expect(await fsp.readFile(outside, 'utf8')).toBe('allowed absolute');
    });
});

describe('skill document seeding in isolated workspace', () => {
    beforeEach(async () => {
        await put('skills/alpha/SKILL.md', '# alpha');
        await put('skills/alpha/reference.md', 'alpha ref');
        await put('skills/beta/SKILL.md', '# beta');
        await put('skills/beta/code.js', 'not a document');
        await put('skills/gamma/SKILL.md', '# gamma');
    });

    it('seeds all markdown only when enabledSkillDirs is omitted', async () => {
        tools = await createShellTools(skills);
        expect(await execute('Read', { path: 'alpha/SKILL.md' })).toEqual({ content: '# alpha' });
        expect(await fsp.readFile(path.join(workspace, 'beta/SKILL.md'), 'utf8')).toBe('# beta');
        await expect(fsp.stat(path.join(workspace, 'beta/code.js'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(tools.Bash!.description).toContain('Available files:');
        expect(tools.Bash!.description).toContain('参考文档');
    });

    it('uses a plain single-directory glob and only seeds enabled documents', async () => {
        tools = await createShellTools(skills, { enabledSkillDirs: ['alpha', '..', 'a/b', 'a\\b', ''] });
        expect(await execute('Read', { path: 'alpha/reference.md' })).toEqual({ content: 'alpha ref' });
        await expect(fsp.stat(path.join(workspace, 'beta'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(tools.Bash!.description).not.toContain('beta/SKILL.md');
    });

    it('uses a brace glob for multiple directories and clears disabled leftovers safely', async () => {
        await fsp.mkdir(path.join(workspace, 'gamma'), { recursive: true });
        await fsp.writeFile(path.join(workspace, 'gamma/old.md'), 'stale');
        const sibling = path.join(path.dirname(workspace), 'do-not-delete');
        await fsp.writeFile(sibling, 'safe');
        tools = await createShellTools(skills, {
            enabledSkillDirs: ['alpha', 'beta'],
            disabledSkillDirs: ['gamma', '../do-not-delete', '', '.', '..', 'nested/dir', 'nested\\dir']
        });
        expect(await execute('Read', { path: 'beta/SKILL.md' })).toEqual({ content: '# beta' });
        await expect(fsp.stat(path.join(workspace, 'gamma'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fsp.readFile(sibling, 'utf8')).toBe('safe');
        await fsp.rm(sibling);
    });

    it.each([{ enabledSkillDirs: [] }, { enabledSkillDirs: ['..', '.', '', 'a/b'] }])(
        'does not seed for empty/sanitized selection %j',
        async ({ enabledSkillDirs }) => {
            tools = await createShellTools(skills, { enabledSkillDirs, disabledSkillDirs: [] });
            expect(await fsp.readdir(workspace)).toEqual([]);
            expect(tools.Bash!.description).toContain('当前工作目录是临时工作区');
            expect(tools.Bash!.description).not.toContain('Available files:');
        }
    );

    it('logs failed stale cleanup but continues construction', async () => {
        const rm = fsp.rm.bind(fsp);
        vi.spyOn(fsp, 'rm').mockImplementation((...args) => {
            if (String(args[0]) === path.join(workspace, 'broken')) return Promise.reject(new Error('fake EACCES'));
            return rm(...args);
        });
        tools = await createShellTools(skills, { enabledSkillDirs: [], disabledSkillDirs: ['broken'] });
        expect(log.warn).toHaveBeenCalledWith('清理停用技能残留目录失败', expect.objectContaining({ dir: 'broken' }));
        expect(tools.Bash).toBeDefined();
    });

    it('copies enabled skill resources except code tools and keeps unchanged files untouched', async () => {
        await put('skills/alpha/scripts/run.py', 'print(1)');
        await put('skills/alpha/tools/index.js', 'export default {}');
        await put('skills/alpha/node_modules/dep/index.js', 'dep');
        await fsp.symlink(path.join(root, 'project'), path.join(skills, 'alpha/linked'));
        tools = await createShellTools(skills, { enabledSkillDirs: ['alpha'] });
        const script = path.join(workspace, 'alpha/scripts/run.py');
        expect(await fsp.readFile(script, 'utf8')).toBe('print(1)');
        for (const skipped of ['alpha/tools', 'alpha/node_modules', 'alpha/linked', 'beta']) {
            await expect(fsp.lstat(path.join(workspace, skipped))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(tools.Bash!.description).toContain('脚本等资源文件也在对应技能目录下');

        // 大小与 mtime 未变：第二次构造不重写（其它会话可能正在执行这份脚本）
        const copy = fsp.cp.bind(fsp);
        const written: string[] = [];
        vi.spyOn(fsp, 'cp').mockImplementation(async (src, dest, opts) => {
            const filter = opts?.filter;
            return copy(src, dest, {
                ...opts,
                filter: async (from, to) => {
                    const keep = filter ? await filter(from, to) : true;
                    if (keep && (await fsp.lstat(from)).isFile()) written.push(String(from));
                    return keep;
                }
            });
        });
        tools = await createShellTools(skills, { enabledSkillDirs: ['alpha'] });
        expect(written).toEqual([]);
        await put('skills/alpha/scripts/run.py', 'print(22)');
        tools = await createShellTools(skills, { enabledSkillDirs: ['alpha'] });
        expect(written).toEqual([path.join(skills, 'alpha/scripts/run.py')]);
        expect(await fsp.readFile(script, 'utf8')).toBe('print(22)');
    });

    it('logs a failed resource sync but still builds the tools', async () => {
        vi.spyOn(fsp, 'cp').mockRejectedValueOnce(new Error('fake EACCES'));
        tools = await createShellTools(skills, { enabledSkillDirs: ['alpha'] });
        expect(log.warn).toHaveBeenCalledWith('同步技能资源到工作区失败', expect.objectContaining({ dir: 'alpha' }));
        expect(tools.Bash).toBeDefined();
    });

    it('never seeds skills into the user project or creates a missing project directory', async () => {
        expect(await fsp.readdir(project)).toEqual([]);
        const missing = path.join(root, 'missing-project');
        const projectTools = await createShellTools(skills, { primaryDir: missing, additionalDirs: [] });
        expect(projectTools.Bash!.description).toContain('用户的项目主目录');
        expect(projectTools.Bash!.description).not.toContain('Available files:');
        await expect(fsp.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

describe('actual approval decisions before actual tool execution', () => {
    it('requires approval in ordinary mode, trusts safe commands, and rejects composed/dangerous commands', async () => {
        const { createPermissionBroker } = await import('@/modules/permission');
        const broker = createPermissionBroker({ dangerMode: false });
        const context = { sessionId: 'shell-session', trust: { roots: [project] } };
        expect(await broker.resolveBash('git status', {})).toBe('user-approval');
        expect(await broker.resolveBash('git status', context)).toBe('approved');
        expect(await broker.resolveBash('git status && rm -rf .', context)).toBe('user-approval');
        expect(await broker.resolveBash('rm -rf .', context)).toBe('user-approval');
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
        if ((await broker.resolveBash('git status', context)) === 'approved') {
            const pending = execute('Bash', { command: 'git status' });
            child.stdout.write(Buffer.from('fake clean status'));
            child.emit('close', 0, null);
            expect(await pending).toMatchObject({ stdout: 'fake clean status', exitCode: 0 });
        } else {
            throw new Error('expected actual broker to approve trusted safe command');
        }
        for (let i = 0; i < 12; i++) await Promise.resolve();
        expect(fsp.appendFile).toHaveBeenCalledTimes(1);
    });

    it('executes approved normal writes but enforces tool guard even in dangerous mode', async () => {
        const { createPermissionBroker } = await import('@/modules/permission');
        const broker = createPermissionBroker({ dangerMode: false });
        const context = { trust: { roots: [project] } };
        const target = path.join(project, 'approved.txt');
        expect(await broker.resolveWrite('relative.txt', context)).toBe('user-approval');
        expect(await broker.resolveWrite(target, context)).toBe('approved');
        await execute('Write', { path: target, content: 'approved' });
        expect(await fsp.readFile(target, 'utf8')).toBe('approved');
        const danger = createPermissionBroker({ dangerMode: true });
        const protectedTarget = path.join(project, '.git/hooks/pre-commit');
        expect(await danger.resolveWrite(protectedTarget, {})).toBe('approved');
        await expect(execute('Write', { path: protectedTarget, content: 'not executed' })).rejects.toThrow(
            '拒绝写入受保护路径'
        );
    });
});
