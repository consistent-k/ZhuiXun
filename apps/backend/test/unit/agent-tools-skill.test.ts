import fsp from 'node:fs/promises';
import path from 'node:path';

import { tool, type ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createSkillTools } from '@/agent/tools/skill-tools';
import type { LoadedSkill, SkillMetadata, SkillRegistry, SkillUpsertInput } from '@/modules/skills';

const options = { toolCallId: 'skill-call', messages: [], context: {} };
const meta: SkillMetadata = {
    id: 'unit-skill',
    name: 'Unit skill',
    description: 'Synthetic skill',
    dirPath: '/synthetic/skills/unit-skill',
    loaded: false,
    triggers: ['test'],
    source: 'user',
    editable: true,
    disabled: false
};
const source: SkillUpsertInput = {
    name: meta.id,
    displayName: meta.name,
    description: meta.description,
    systemPrompt: 'Synthetic instructions',
    triggers: ['test'],
    allowedTools: ['Read'],
    disallowedTools: ['Write'],
    extraMetadata: { provenance: 'synthetic' }
};
const skill: LoadedSkill = {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    systemPrompt: source.systemPrompt,
    tools: {},
    toolInfo: []
};

function fixture() {
    const fake = {
        listMetadata: vi
            .fn<SkillRegistry['listMetadata']>()
            .mockReturnValue([meta, { ...meta, id: 'disabled', disabled: true }]),
        getMetadataById: vi.fn<SkillRegistry['getMetadataById']>().mockReturnValue(meta),
        get: vi.fn<SkillRegistry['get']>().mockResolvedValue(skill),
        listResourceFiles: vi.fn<SkillRegistry['listResourceFiles']>().mockResolvedValue(['references/guide.md']),
        hasUserDir: vi.fn<SkillRegistry['hasUserDir']>().mockReturnValue(true),
        getSkillSource: vi.fn<SkillRegistry['getSkillSource']>().mockResolvedValue(source),
        createUserSkill: vi.fn<SkillRegistry['createUserSkill']>().mockResolvedValue(meta),
        updateUserSkill: vi.fn<SkillRegistry['updateUserSkill']>().mockResolvedValue(meta)
    };
    // 仅替换 registry 外部端口；实际执行的 load/create/update/binding 均为生产实现。
    const registry = fake as unknown as SkillRegistry;
    return { fake, registry, tools: createSkillTools(registry, { allowWrite: true }) as ToolSet };
}

async function execute(tools: ToolSet, name: string, input: unknown = {}) {
    return tools[name].execute!(input, options);
}

describe('agent skill tools execute', () => {
    it('defaults to readonly meta tools and lists only enabled public metadata', async () => {
        const f = fixture();
        const tools = createSkillTools(f.registry);
        expect(Object.keys(tools)).toEqual(['load_skill', 'list_skills']);
        expect(await tools.list_skills.execute!({}, options)).toEqual({
            skills: [
                { id: meta.id, name: meta.name, description: meta.description, triggers: ['test'], editable: true }
            ]
        });
        expect(await tools.load_skill.execute!({ skillId: meta.id }, options)).toMatchObject({
            success: true,
            skillId: meta.id,
            instructions: source.systemPrompt,
            directory: meta.dirPath,
            files: ['references/guide.md'],
            availableTools: [],
            guidance: expect.stringContaining('需要时仍应使用本轮已有的相关工具')
        });
    });

    describe('workspace copy', () => {
        const files = ['references/guide.md', 'scripts/run.py', 'tools/index.js'];
        async function setup(copied: string[]) {
            const workspaceDir = await fsp.mkdtemp(path.join(process.env.ZHUIXUN_TEST_HOME!, 'skill-ws-'));
            for (const file of copied) {
                await fsp.mkdir(path.dirname(path.join(workspaceDir, 'unit-skill', file)), { recursive: true });
                await fsp.writeFile(path.join(workspaceDir, 'unit-skill', file), file);
            }
            const f = fixture();
            f.fake.listResourceFiles.mockResolvedValue(files);
            return { f, workspaceDir, tools: createSkillTools(f.registry, { workspaceDir }) as ToolSet };
        }

        it('points a fully seeded user skill at the workspace copy and drops unseeded code tools', async () => {
            const { tools, workspaceDir } = await setup(['SKILL.md', 'references/guide.md', 'scripts/run.py']);
            const result = await execute(tools, 'load_skill', { skillId: meta.id });
            expect(result).toMatchObject({
                directory: path.join(workspaceDir, 'unit-skill'),
                files: ['references/guide.md', 'scripts/run.py'],
                guidance: expect.stringContaining('当前工作目录下的副本')
            });
            await fsp.rm(workspaceDir, { recursive: true });
        });

        it.each([
            ['an incomplete copy', ['SKILL.md', 'references/guide.md'], meta],
            [
                'a read-only external skill',
                ['SKILL.md', 'references/guide.md', 'scripts/run.py'],
                { ...meta, source: 'builtin' as const }
            ]
        ])('falls back to the source directory for %s', async (_label, copied, value) => {
            const { f, tools, workspaceDir } = await setup(copied);
            f.fake.getMetadataById.mockReturnValue(value);
            const result = await execute(tools, 'load_skill', { skillId: meta.id });
            expect(result).toMatchObject({
                directory: meta.dirPath,
                files,
                guidance: expect.stringContaining('技能源目录保持只读')
            });
            await fsp.rm(workspaceDir, { recursive: true });
        });
    });

    it.each(['unit_skill', 'UNIT-SKILL', 'Unit_Skill'])(
        'loads %s that only differs by case or _/- under the canonical id',
        async (requested) => {
            const f = fixture();
            f.fake.getMetadataById.mockReturnValue(undefined);
            f.fake.listMetadata.mockReturnValue([meta]);
            expect(await execute(f.tools, 'load_skill', { skillId: requested })).toMatchObject({
                success: true,
                skillId: meta.id
            });
            expect(f.fake.get).toHaveBeenCalledExactlyOnceWith(meta.id);
            expect(f.fake.listResourceFiles).toHaveBeenCalledExactlyOnceWith(meta.id);
        }
    );

    it.each([
        ['a disabled normalized match', [{ ...meta, disabled: true }], []],
        ['ambiguous normalized matches', [meta, { ...meta, id: 'unit_skill' }], [meta.id, 'unit_skill']],
        ['edits beyond case and _/-', [{ ...meta, id: 'unit-skills' }], ['unit-skills']]
    ])('does not guess for %s', async (_label, list, enabled) => {
        const f = fixture();
        f.fake.getMetadataById.mockReturnValue(undefined);
        f.fake.listMetadata.mockReturnValue(list);
        expect(await execute(f.tools, 'load_skill', { skillId: 'Unit_Skill' })).toEqual({
            success: false,
            error: '技能 Unit_Skill 不存在',
            availableSkills: enabled
        });
        expect(f.fake.get).not.toHaveBeenCalled();
    });

    it.each([undefined, { ...meta, disabled: true }])(
        'refuses nonexistent/disabled skill %s without loading it',
        async (value) => {
            const f = fixture();
            f.fake.getMetadataById.mockReturnValue(value);
            const result = await execute(f.tools, 'load_skill', { skillId: 'rejected' });
            expect(result).toEqual({
                success: false,
                error: value ? '技能 rejected 已停用' : '技能 rejected 不存在',
                availableSkills: [meta.id]
            });
            expect(f.fake.get).not.toHaveBeenCalled();
        }
    );

    it('reports lazy loader failure and filters disabled alternatives', async () => {
        const f = fixture();
        f.fake.get.mockResolvedValue(undefined);
        expect(await execute(f.tools, 'load_skill', { skillId: meta.id })).toEqual({
            success: false,
            error: `技能 ${meta.id} 加载失败`,
            availableSkills: [meta.id]
        });
    });

    it('binds declared tools, honors deny rules and gives skill code tools collision precedence', async () => {
        const f = fixture();
        const baseRead = tool({ inputSchema: z.object({}), execute: async () => 'base read' });
        const codeRead = tool({ inputSchema: z.object({}), execute: async () => 'skill read' });
        const mcp = tool({ inputSchema: z.object({}), execute: async () => 'mcp result' });
        f.fake.get.mockResolvedValue({
            ...skill,
            allowedTools: ['Read', 'Write', 'WebFetch', 'mcp__docs__lookup'],
            disallowedTools: ['Write'],
            tools: { Read: codeRead }
        });
        const onSkillLoaded = vi.fn();
        const getBindingPools = vi.fn(async () => ({
            shellTools: { Read: baseRead, Write: baseRead },
            webTools: { WebFetch: baseRead },
            mcpTools: { docs_lookup: mcp }
        }));
        const tools = createSkillTools(f.registry, { onSkillLoaded, getBindingPools });
        expect(await tools.load_skill.execute!({ skillId: meta.id }, options)).toMatchObject({
            success: true,
            availableTools: ['Read', 'WebFetch', 'docs_lookup'],
            guidance: expect.stringContaining('不是本轮工具全集')
        });
        expect(getBindingPools).toHaveBeenCalledOnce();
        const injected: ToolSet = onSkillLoaded.mock.calls[0][0];
        expect(injected.Read).toBe(codeRead);
        expect(await injected.Read.execute!({}, options)).toBe('skill read');
        expect(await injected.docs_lookup.execute!({}, options)).toBe('mcp result');
        expect(injected).not.toHaveProperty('Write');
    });

    it('falls back to code tools when binding-pool lookup rejects', async () => {
        const f = fixture();
        f.fake.get.mockResolvedValue({ ...skill, allowedTools: ['Read'], tools: undefined } as unknown as LoadedSkill);
        const onSkillLoaded = vi.fn();
        const tools = createSkillTools(f.registry, {
            onSkillLoaded,
            getBindingPools: async () => {
                throw new Error('pool unavailable');
            }
        });
        expect(await tools.load_skill.execute!({ skillId: meta.id }, options)).toMatchObject({
            success: true,
            availableTools: [],
            guidance: expect.stringContaining('需要时仍应使用本轮已有的相关工具')
        });
        expect(onSkillLoaded).toHaveBeenCalledWith({});
    });

    it('does not advertise code tools that are not actually mounted without a callback', async () => {
        const f = fixture();
        const code = tool({ inputSchema: z.object({}), execute: async () => 'ok' });
        f.fake.get.mockResolvedValue({ ...skill, allowedTools: [], tools: { custom: code } });
        const getBindingPools = vi.fn();
        const tools = createSkillTools(f.registry, { getBindingPools });
        expect(await tools.load_skill.execute!({ skillId: meta.id }, options)).toMatchObject({
            availableTools: []
        });
        expect(getBindingPools).not.toHaveBeenCalled();
    });

    it('keeps existing WebFetch usable for workflow-only skills without pretending to add tools', async () => {
        const f = fixture();
        const WebFetch = tool({ inputSchema: z.object({}), execute: async () => 'page' });
        const tools = createSkillTools(f.registry, { getAvailableTools: () => ({ WebFetch }) });
        const result = await tools.load_skill.execute!({ skillId: meta.id }, options);
        expect(result).toMatchObject({
            instructions: source.systemPrompt,
            availableTools: [],
            guidance: expect.stringContaining('web_fetch 应按 WebFetch 的实际参数定义调用')
        });
        expect(result).not.toHaveProperty('systemPrompt');
    });

    it('reports only mounted tools after the injection callback has completed', async () => {
        const f = fixture();
        const code = tool({ inputSchema: z.object({}), execute: async () => 'ok' });
        f.fake.get.mockResolvedValue({ ...skill, tools: { custom: code, unavailable: code } });
        const liveTools: ToolSet = {};
        const tools = createSkillTools(f.registry, {
            onSkillLoaded: (loaded) => {
                liveTools.custom = loaded.custom;
            },
            getAvailableTools: () => liveTools
        });
        expect(await tools.load_skill.execute!({ skillId: meta.id }, options)).toMatchObject({
            availableTools: ['custom'],
            guidance: expect.not.stringContaining('web_fetch 应按 WebFetch')
        });
    });

    it('creates using the dedicated registry write port and returns the persisted location', async () => {
        const f = fixture();
        const { extraMetadata: _unused, ...input } = source;
        expect(await execute(f.tools, 'create_skill', input)).toEqual({
            success: true,
            skillId: meta.id,
            path: meta.dirPath,
            note: expect.stringContaining('重扫')
        });
        expect(f.fake.createUserSkill).toHaveBeenCalledWith(input);
    });

    it.each(['create_skill', 'update_skill'])(
        '%s rejects missing user root without attempting writes',
        async (name) => {
            const f = fixture();
            f.fake.hasUserDir.mockReturnValue(false);
            expect(await execute(f.tools, name, source)).toMatchObject({
                success: false,
                error: expect.stringContaining('未配置用户技能目录')
            });
            expect(f.fake.createUserSkill).not.toHaveBeenCalled();
            expect(f.fake.getMetadataById).not.toHaveBeenCalled();
        }
    );

    it('merges only defined patch fields, preserving body/rules/provenance while allowing explicit empty arrays', async () => {
        const f = fixture();
        expect(
            await execute(f.tools, 'update_skill', {
                name: meta.id,
                description: 'new',
                displayName: undefined,
                triggers: []
            })
        ).toMatchObject({ success: true, skillId: meta.id, path: meta.dirPath });
        expect(f.fake.updateUserSkill).toHaveBeenCalledWith(meta.id, { ...source, description: 'new', triggers: [] });
    });

    it.each([
        [undefined, '不存在'],
        [{ ...meta, source: 'builtin' as const }, '只读技能根'],
        [{ ...meta, editable: false }, '只读技能根']
    ] as const)('refuses update for metadata %s', async (metadata, message) => {
        const f = fixture();
        f.fake.getMetadataById.mockReturnValue(metadata);
        expect(await execute(f.tools, 'update_skill', { name: meta.id })).toMatchObject({
            success: false,
            error: expect.stringContaining(message)
        });
        expect(f.fake.getSkillSource).not.toHaveBeenCalled();
        expect(f.fake.updateUserSkill).not.toHaveBeenCalled();
    });

    it('rejects unreadable sources without clearing the old skill', async () => {
        const f = fixture();
        f.fake.getSkillSource.mockResolvedValue(undefined);
        expect(await execute(f.tools, 'update_skill', { name: meta.id })).toMatchObject({
            success: false,
            error: expect.stringContaining('源文件读取失败')
        });
        expect(f.fake.updateUserSkill).not.toHaveBeenCalled();
    });

    it.each(['create_skill', 'update_skill'])('%s structures Error, conflict and non-Error failures', async (name) => {
        const f = fixture();
        const writer = name === 'create_skill' ? f.fake.createUserSkill : f.fake.updateUserSkill;
        for (const [error, expected] of [
            [
                Object.assign(new Error('already exists'), { code: 'CONFLICT' }),
                'already exists；如需改动请改用 update_skill'
            ],
            [new Error('permission denied'), 'permission denied'],
            ['non-error failure', 'non-error failure'],
            [null, 'null']
        ]) {
            writer.mockRejectedValueOnce(error);
            expect(await execute(f.tools, name, source)).toEqual({ success: false, error: expected });
        }
    });
});
