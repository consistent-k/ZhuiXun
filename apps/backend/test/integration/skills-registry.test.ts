import fs from 'node:fs/promises';
import path from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MCPClientManager, MCPToolAdapter, MCPToolDiscovery } from '@/modules/mcp';
import { serializeSkillMarkdown } from '@/modules/skills/loader';
import type { SkillUpsertInput } from '@/modules/skills/loader';
import { SkillRegistry } from '@/modules/skills/registry';
import { readSkillsState } from '@/modules/skills/store';

import { createTempData } from '../helpers/temp-data';
import type { TempData } from '../helpers/temp-data';

let temp: TempData;
let external: string;
let registry: SkillRegistry;
const input = (name = 'sample', systemPrompt = '正文'): SkillUpsertInput => ({
    name,
    displayName: '展示名',
    description: '描述',
    systemPrompt,
    triggers: ['示例'],
    extraMetadata: { source_canonical: `@test/${name}` }
});
const addSkill = async (root: string, dirname: string, source = input(dirname)) => {
    const dir = path.join(root, dirname);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), serializeSkillMarkdown(source));
    return dir;
};

beforeEach(async () => {
    temp = await createTempData('skills-registry-');
    external = path.join(temp.root, 'external');
    // 空配置 manager 只保存配置，不连接、不启动 healthcheck，也不会创建真实传输。
    registry = new SkillRegistry(new MCPClientManager([]), temp.skills, [external]);
});
afterEach(async () => {
    vi.restoreAllMocks();
    await temp.cleanup();
});

describe('skills registry discovery', () => {
    it('scans missing roots, ignores non-skills and malformed YAML, supports directory symlinks', async () => {
        await registry.scan();
        expect(registry.listMetadata()).toEqual([]);
        expect(registry.getCatalog()).toContain('暂无可用技能');
        await fs.mkdir(path.join(external, 'not-skill'), { recursive: true });
        await fs.writeFile(path.join(external, 'regular.txt'), 'not a directory');
        await fs.symlink(path.join(external, 'missing'), path.join(external, 'broken-link'));
        await fs.symlink(path.join(external, 'regular.txt'), path.join(external, 'file-link'));
        const linked = await addSkill(path.join(temp.root, 'trusted'), 'linked', {
            name: 'linked',
            description: '',
            systemPrompt: 'linked body'
        });
        await fs.symlink(linked, path.join(external, 'linked'));
        const bad = await addSkill(external, 'bad-yaml');
        await fs.writeFile(path.join(bad, 'SKILL.md'), '---\nname: [bad\n---\nbody');
        await fs.mkdir(path.join(external, 'fallback'));
        await fs.writeFile(path.join(external, 'fallback/SKILL.md'), '---\ntriggers: scalar\n---\nbody');
        await registry.scan();
        expect(
            registry
                .listMetadata()
                .map((m) => m.id)
                .sort()
        ).toEqual(['fallback', 'linked']);
        expect(registry.getMetadataById('linked')).toMatchObject({
            id: 'linked',
            name: 'linked',
            description: '',
            source: 'builtin',
            editable: false,
            dirPath: path.join(external, 'linked'),
            disabled: false,
            loaded: false,
            triggers: undefined,
            sourceCanonical: undefined
        });
        expect(registry.getMetadataById('fallback')).toMatchObject({ id: 'fallback', triggers: undefined });
    });

    it('deduplicates roots, gives user overrides priority and reflects removal on rescan', async () => {
        const secondExternal = path.join(temp.root, 'external-two');
        await addSkill(external, 'sample', input('sample', 'first external'));
        await addSkill(secondExternal, 'sample', input('sample', 'second external'));
        await addSkill(temp.skills, 'physical-dir', input('sample', 'user body'));
        registry = new SkillRegistry(new MCPClientManager([]), temp.skills, [
            external,
            path.join(external, '.'),
            secondExternal,
            temp.skills
        ]);
        await registry.scan();
        expect(registry.listMetadata()).toHaveLength(1);
        expect(registry.getMetadataById('sample')).toMatchObject({
            source: 'user',
            editable: true,
            name: '展示名',
            dirPath: path.join(temp.skills, 'physical-dir'),
            triggers: ['示例'],
            sourceCanonical: '@test/sample'
        });
        expect(registry.getSkillsDir()).toBe(temp.skills);
        expect(registry.hasUserDir()).toBe(true);
        expect(registry.getUserSkillDirNames()).toEqual({ enabled: ['physical-dir'], disabled: [] });
        await fs.rm(path.join(temp.skills, 'physical-dir'), { recursive: true });
        await registry.scan();
        expect(registry.getMetadataById('sample')).toMatchObject({
            source: 'builtin',
            dirPath: path.join(secondExternal, 'sample')
        });
        expect(await registry.getSkillSource('sample')).toMatchObject({ systemPrompt: 'second external' });
        expect(registry.getUserSkillDirNames()).toEqual({ enabled: [], disabled: [] });
        await fs.rm(secondExternal, { recursive: true });
        await fs.rm(external, { recursive: true });
        await registry.scan();
        expect(registry.listMetadata()).toEqual([]);
        expect(registry.getMetadataById('sample')).toBeUndefined();
        await expect(registry.getSkillSource('missing')).resolves.toBeUndefined();
    });
});

describe('skills registry resource files', () => {
    it('lists sorted relative files from a shared skill, including nested SKILL.md but excluding the top-level one', async () => {
        const dir = await addSkill(external, 'shared');
        await fs.mkdir(path.join(dir, 'references/deep'), { recursive: true });
        await fs.mkdir(path.join(dir, 'empty'));
        for (const file of [
            'z-last.txt',
            'references/z-last.md',
            'references/deep/guide.md',
            'references/SKILL.md',
            'a-first.txt',
            'README.md'
        ]) {
            await fs.writeFile(path.join(dir, file), 'resource');
        }
        await registry.scan();

        await expect(registry.listResourceFiles('shared')).resolves.toEqual([
            'README.md',
            'a-first.txt',
            'references/SKILL.md',
            'references/deep/guide.md',
            'references/z-last.md',
            'z-last.txt'
        ]);
        expect(registry.listLoaded()).toEqual([]);
    });

    it('uses the user override directory rather than merging resources from the shared skill', async () => {
        const shared = await addSkill(external, 'shared-folder', input('sample'));
        await fs.writeFile(path.join(shared, 'shared-only.md'), 'shared resource');
        await registry.scan();
        await expect(registry.listResourceFiles('sample')).resolves.toEqual(['shared-only.md']);

        const user = await addSkill(temp.skills, 'user-folder', input('sample'));
        await fs.mkdir(path.join(user, 'references'));
        await fs.writeFile(path.join(user, 'references/user-only.md'), 'user resource');
        await registry.scan();

        await expect(registry.listResourceFiles('sample')).resolves.toEqual(['references/user-only.md']);
    });

    it.each([false, true])(
        'does not follow resource symlinks when the skill directory is a symlink: %s',
        async (linked) => {
            const dir = await addSkill(linked ? path.join(temp.root, 'trusted') : external, 'sample');
            await fs.mkdir(path.join(dir, 'references'));
            await fs.writeFile(path.join(dir, 'references/guide.md'), 'guide');
            const outside = path.join(temp.root, 'outside');
            await fs.mkdir(outside);
            await fs.writeFile(path.join(outside, 'private.md'), 'temporary fixture');
            await fs.symlink(path.join(outside, 'private.md'), path.join(dir, 'file-link.md'));
            await fs.symlink(outside, path.join(dir, 'directory-link'));
            await fs.symlink(path.join(dir, 'references'), path.join(dir, 'internal-directory-link'));
            await fs.symlink(path.join(outside, 'missing.md'), path.join(dir, 'references/broken-link.md'));
            await fs.symlink(dir, path.join(dir, 'references/cycle'));
            if (linked) {
                await fs.mkdir(external, { recursive: true });
                await fs.symlink(dir, path.join(external, 'sample'));
            }
            await registry.scan();
            expect(registry.getMetadataById('sample')?.dirPath).toBe(path.join(external, 'sample'));

            await expect(registry.listResourceFiles('sample')).resolves.toEqual(['references/guide.md']);
        }
    );

    it('supports a shared skills root that is itself a directory symlink', async () => {
        const root = path.join(temp.root, 'shared-target');
        const dir = await addSkill(root, 'sample');
        await fs.writeFile(path.join(dir, 'guide.md'), 'guide');
        await fs.symlink(root, external);
        await registry.scan();

        await expect(registry.listResourceFiles('sample')).resolves.toEqual(['guide.md']);
    });

    it('returns an empty list for an unknown skill or a skill without resource files', async () => {
        await addSkill(temp.skills, 'empty');
        await registry.scan();

        await expect(registry.listResourceFiles('missing')).resolves.toEqual([]);
        await expect(registry.listResourceFiles('empty')).resolves.toEqual([]);
    });

    it.each(['shared', 'user'])(
        'returns an empty list for a disabled %s skill and lists resources after re-enabling',
        async (source) => {
            const dir = await addSkill(source === 'shared' ? external : temp.skills, 'sample');
            await fs.writeFile(path.join(dir, 'guide.md'), 'guide');
            await registry.scan();
            await expect(registry.listResourceFiles('sample')).resolves.toEqual(['guide.md']);

            await registry.toggleSkill('sample');
            await expect(registry.listResourceFiles('sample')).resolves.toEqual([]);

            await registry.toggleSkill('sample');
            await expect(registry.listResourceFiles('sample')).resolves.toEqual(['guide.md']);
        }
    );
});

describe('skills registry lazy loading', () => {
    it('deduplicates concurrent loads, caches instances and exposes MCP adapter/discovery without connections', async () => {
        await addSkill(temp.skills, 'sample');
        await registry.scan();
        const [first, second] = await Promise.all([registry.load('sample'), registry.get('sample')]);
        expect(first).toBeDefined();
        expect(first).toBe(second);
        await expect(registry.get('sample')).resolves.toBe(first);
        expect(registry.listLoaded()).toEqual([first]);
        expect(registry.getMetadataById('sample')?.loaded).toBe(true);
        await expect(registry.load('missing')).resolves.toBeUndefined();
        expect(registry.getMCPAdapter()).toBeInstanceOf(MCPToolAdapter);
        expect(registry.getMCPDiscovery()).toBeInstanceOf(MCPToolDiscovery);
        await expect(registry.getMCPAdapter().getAllTools()).resolves.toEqual({});
        await expect(registry.getMCPDiscovery().getAllTools()).resolves.toEqual([]);
    });

    it('returns undefined for failed loads and retries after repairing the source', async () => {
        const dir = await addSkill(temp.skills, 'sample');
        await registry.scan();
        await fs.writeFile(path.join(dir, 'SKILL.md'), 'invalid');
        await expect(registry.load('sample')).resolves.toBeUndefined();
        expect(registry.listLoaded()).toEqual([]);
        expect(registry.getMetadataById('sample')?.loaded).toBe(false);
        await fs.writeFile(path.join(dir, 'SKILL.md'), serializeSkillMarkdown(input()));
        await expect(registry.load('sample')).resolves.toMatchObject({ id: 'sample', systemPrompt: '正文' });
        expect(registry.listLoaded()).toHaveLength(1);
    });

    it('loadAll keeps disabled skills while loadEnabled skips disabled and failed skills', async () => {
        const broken = await addSkill(temp.skills, 'broken');
        await addSkill(temp.skills, 'disabled');
        await addSkill(temp.skills, 'enabled');
        await registry.scan();
        await registry.toggleSkill('disabled');
        await fs.rm(path.join(broken, 'SKILL.md'));
        expect((await registry.loadEnabled()).map((s) => s.id)).toEqual(['enabled']);
        expect((await registry.loadAll()).map((s) => s.id)).toEqual(['disabled', 'enabled']);
        expect(registry.getEnabledMetadata().map((s) => s.id)).toEqual(['broken', 'enabled']);
        expect(registry.getCatalog()).not.toContain('- disabled:');
        expect(registry.getCatalog()).toContain('- enabled: 描述（触发词：示例）');
    });
});

describe('skills registry mutations', () => {
    it('creates, rejects duplicate user ids, updates without renaming and invalidates runtime caches', async () => {
        expect(await registry.createUserSkill(input())).toMatchObject({ id: 'sample', source: 'user', loaded: false });
        const before = await registry.load('sample');
        await expect(registry.createUserSkill(input())).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(
            registry.updateUserSkill('sample', input('attempted-rename', 'updated body'))
        ).resolves.toMatchObject({ id: 'sample', loaded: false });
        const after = await registry.load('sample');
        expect(after).not.toBe(before);
        expect(after).toMatchObject({ id: 'sample', systemPrompt: 'updated body' });
        expect(await fs.readdir(temp.skills)).toEqual(['sample']);
        await expect(registry.getSkillSource('sample')).resolves.toMatchObject({
            name: 'sample',
            systemPrompt: 'updated body'
        });
        await registry.removeUserSkill('sample');
        expect(registry.listMetadata()).toEqual([]);
        expect(registry.listLoaded()).toEqual([]);
        await expect(registry.get('sample')).resolves.toBeUndefined();
    });

    it('forbids edits/deletion of external skills but permits user overrides with deletion fallback', async () => {
        const dir = await addSkill(external, 'sample', input('sample', 'external body'));
        const original = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        await registry.scan();
        await expect(registry.updateUserSkill('sample', input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(registry.removeUserSkill('sample')).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await registry.createUserSkill(input('sample', 'user override'));
        await expect(registry.get('sample')).resolves.toMatchObject({ systemPrompt: 'user override' });
        await registry.removeUserSkill('sample');
        expect(registry.getMetadataById('sample')).toMatchObject({ source: 'builtin', editable: false });
        await expect(registry.get('sample')).resolves.toMatchObject({ systemPrompt: 'external body' });
        expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(original);
    });

    it('rejects missing metadata and every write API when userDir is unconfigured', async () => {
        await expect(registry.updateUserSkill('missing', input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(registry.removeUserSkill('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(registry.toggleSkill('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(registry.exportSkill('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const readonly = new SkillRegistry(new MCPClientManager([]), '');
        expect(readonly.hasUserDir()).toBe(false);
        await expect(readonly.createUserSkill(input())).rejects.toThrow('未配置用户技能目录');
        await expect(readonly.updateUserSkill('sample', input())).rejects.toThrow('未配置用户技能目录');
        await expect(readonly.removeUserSkill('sample')).rejects.toThrow('未配置用户技能目录');
        await expect(readonly.toggleSkill('sample')).rejects.toThrow('未配置用户技能目录');
        await expect(readonly.importSkill('md', serializeSkillMarkdown(input()))).rejects.toThrow('未配置用户技能目录');
    });

    it('serializes concurrent different-id and same-id toggles and persists external flags only in userDir', async () => {
        const extDir = await addSkill(external, 'external');
        const original = await fs.readFile(path.join(extDir, 'SKILL.md'), 'utf8');
        await addSkill(temp.skills, 'user');
        await registry.scan();
        await registry.loadAll();
        await expect(Promise.all([registry.toggleSkill('external'), registry.toggleSkill('user')])).resolves.toEqual([
            true,
            true
        ]);
        expect(new Set((await readSkillsState(temp.skills)).disabled)).toEqual(new Set(['external', 'user']));
        expect(registry.getEnabledMetadata()).toEqual([]);
        expect(registry.listLoaded()).toEqual([]);
        expect(registry.getUserSkillDirNames()).toEqual({ enabled: [], disabled: ['user'] });
        await expect(Promise.all([registry.toggleSkill('user'), registry.toggleSkill('user')])).resolves.toEqual([
            false,
            true
        ]);
        expect(registry.getMetadataById('user')?.disabled).toBe(true);
        await registry.toggleSkill('user');
        expect(registry.getUserSkillDirNames()).toEqual({ enabled: ['user'], disabled: [] });
        const restarted = new SkillRegistry(new MCPClientManager([]), temp.skills, [external]);
        await restarted.scan();
        expect(restarted.getMetadataById('external')?.disabled).toBe(true);
        expect(await fs.readFile(path.join(extDir, 'SKILL.md'), 'utf8')).toBe(original);
        expect(await fs.readdir(external)).toEqual(['external']);
    });

    it('keeps the toggle queue usable after a disk failure', async () => {
        await addSkill(temp.skills, 'sample');
        await registry.scan();
        const original = fs.writeFile.bind(fs);
        let failNextStateWrite = true;
        vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
            if (String(args[0]).includes('skills-state.json') && failNextStateWrite) {
                failNextStateWrite = false;
                throw new Error('injected state failure');
            }
            return original(...args);
        });
        await expect(registry.toggleSkill('sample')).rejects.toThrow('injected state failure');
        await expect(registry.toggleSkill('sample')).resolves.toBe(true);
        expect(registry.getMetadataById('sample')?.disabled).toBe(true);
        expect(await fs.readdir(temp.skills)).toEqual(['sample', 'skills-state.json']);
    });

    it('imports markdown/zip with options, invalidates caches and exports external and user resources', async () => {
        await addSkill(external, 'external');
        await registry.scan();
        const externalZip = unzipSync(await registry.exportSkill('external'));
        expect(strFromU8(externalZip['SKILL.md'])).toBe(serializeSkillMarkdown(input('external')));
        await expect(registry.importSkill('md', serializeSkillMarkdown(input()))).resolves.toBe('sample');
        await registry.load('sample');
        const zipped = zipSync({
            'SKILL.md': strToU8(serializeSkillMarkdown(input('old-id', 'zip body'))),
            'docs/guide.md': strToU8('guide'),
            'README.md': strToU8('retain root')
        });
        await expect(
            registry.importSkill('zip', zipped, {
                rewriteSkillMd: (md) => md.replace('name: old-id', 'name: sample'),
                blockedResourceDirs: ['tools/']
            })
        ).resolves.toBe('sample');
        expect(registry.listLoaded()).toEqual([]);
        await expect(registry.get('sample')).resolves.toMatchObject({ systemPrompt: 'zip body' });
        expect(await fs.readFile(path.join(temp.skills, 'sample', 'docs/guide.md'), 'utf8')).toBe('guide');
        const portable = unzipSync(await registry.exportSkill('sample'));
        expect(Object.keys(portable)).toEqual(['SKILL.md']);
        expect(strFromU8(portable['SKILL.md'])).toContain('zip body');
        await expect(registry.importSkill('md', 'invalid')).rejects.toThrow();
        expect(registry.getMetadataById('sample')).toBeDefined();
    });
});
