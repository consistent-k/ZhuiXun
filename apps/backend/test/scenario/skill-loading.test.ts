import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ProviderModule from '@/agent/model/provider';
import {
    addProvider,
    deleteProvider,
    listProviders,
    setActiveModel,
    updateAppSettings,
    updateWebSettings
} from '@/config/settings-store';
import { WORKSPACE_DIR } from '@/config/shell';
import { getConversationStore } from '@/modules/conversations';
import { getPermissionStore } from '@/modules/permission';
import type { LoadedSkill, SkillMetadata } from '@/modules/skills';
import { WebAccessError } from '@/platform/web';
import type * as WebModule from '@/platform/web';

import {
    approvalOf,
    expectStopReason,
    expectToolSequence,
    fakeRegistry,
    runScenarioTurn,
    scriptedModel,
    userMessage
} from '../helpers/scenario';

const state = vi.hoisted(() => ({ model: undefined as unknown, fetch: vi.fn() }));
vi.mock('@/agent/model/provider', async (original) => ({
    ...(await original<typeof ProviderModule>()),
    createModel: () => state.model
}));
// 只替换网页抓取边界；WebFetch schema、执行映射、SDK 循环和审批均走生产实现。
vi.mock('@/platform/web', async (original) => ({
    ...(await original<typeof WebModule>()),
    fetchReadablePage: state.fetch
}));

const meta: SkillMetadata = {
    id: 'multi-search-engine',
    name: 'Search workflow',
    description: 'Synthetic search workflow',
    dirPath: '/synthetic/shared-skills/multi-search-engine',
    loaded: false,
    source: 'builtin',
    editable: false,
    disabled: false
};
const skill: LoadedSkill = {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    systemPrompt: '使用 web_fetch 读取 https://search.invalid/?q=synthetic，并按来源回答。',
    tools: {},
    toolInfo: []
};

function registryFixture() {
    const registry = fakeRegistry();
    registry.getCatalog = () => `## 可用技能\n- ${meta.id}: ${meta.description}`;
    registry.getMetadataById = (id) => (id === meta.id ? meta : undefined);
    registry.listMetadata = () => [meta];
    registry.get = vi.fn(async () => skill);
    registry.loadEnabled = async () => [skill];
    registry.listResourceFiles = async () => ['references/advanced-search.md'];
    return registry;
}

beforeEach(async () => {
    for (const provider of listProviders()) deleteProvider(provider.name);
    addProvider({
        name: 'scenario',
        kind: 'openai-compatible',
        baseURL: 'https://model.invalid/v1',
        apiKey: 'synthetic',
        models: ['scripted']
    });
    setActiveModel('scenario/scripted');
    updateAppSettings({ maxAgentSteps: 10, repeatErrorLimit: 3, autoCompactEnabled: false });
    updateWebSettings({ enabled: true, fetchEnabled: true, requireApproval: 'never' });
    await getPermissionStore().setRules({ deny: [], ask: [], allow: [] });
    state.fetch.mockReset().mockResolvedValue({
        url: 'https://search.invalid/?q=synthetic',
        content: 'Synthetic search evidence',
        truncated: false
    });
});

describe('scenario: skill loading and SDK call repair', () => {
    it.each(['routed', 'progressive'] as const)(
        '%s repairs a skill id call, uses existing WebFetch and persists a successful turn',
        async (agentMode) => {
            const model = scriptedModel([
                { toolCalls: [{ name: meta.id, input: { query: 'synthetic' }, id: 'misnamed-call' }] },
                { toolCalls: [{ name: 'WebFetch', input: { url: 'https://search.invalid/?q=synthetic' } }] },
                { text: '根据检索来源，已找到信息。' }
            ]);
            state.model = model;
            const sessionId = randomUUID();
            const result = await runScenarioTurn(
                { messages: [userMessage('用共享搜索技能查资料')], sessionId, agentMode },
                registryFixture()
            );
            expectToolSequence(result, ['load_skill', 'WebFetch']);
            expect(approvalOf(result, 'load_skill')).toBe('executed');
            expect(approvalOf(result, 'WebFetch')).toBe('executed');
            expectStopReason(result, undefined);
            expect(result.chunks.some((chunk) => chunk.type === 'error' || chunk.type === 'tool-output-error')).toBe(
                false
            );
            const nextPrompt = JSON.stringify(model.doStreamCalls[1].prompt);
            expect(nextPrompt).toContain('instructions');
            expect(nextPrompt).toContain('web_fetch 应按 WebFetch');
            expect(nextPrompt).toContain('references/advanced-search.md');
            expect(nextPrompt).toContain('availableTools');
            expect(state.fetch).toHaveBeenCalledOnce();
            expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain('Synthetic search evidence');
            await vi.waitFor(async () => {
                const saved = await getConversationStore().get(sessionId);
                const reply = saved?.messages.at(-1);
                expect(reply?.role).toBe('assistant');
                expect((reply?.metadata as Record<string, unknown> | undefined)?.stopReason).toBeUndefined();
                expect(reply?.parts).toContainEqual(
                    expect.objectContaining({
                        type: 'tool-load_skill',
                        toolCallId: 'misnamed-call',
                        input: { skillId: meta.id },
                        state: 'output-available'
                    })
                );
            });
        }
    );

    describe.each(['routed', 'progressive'] as const)('%s web evidence flow', (agentMode) => {
        it('loads the workflow before fetching and passes the result to the next model step', async () => {
            const model = scriptedModel([
                { toolCalls: [{ name: 'load_skill', input: { skillId: meta.id }, id: 'workflow' }] },
                {
                    toolCalls: [
                        { name: 'WebFetch', input: { url: 'https://search.invalid/?q=synthetic' }, id: 'fetch' }
                    ]
                },
                { text: '场景完成。' }
            ]);
            state.model = model;
            const sessionId = randomUUID();
            const result = await runScenarioTurn(
                { messages: [userMessage('使用搜索技能查资料')], sessionId, agentMode },
                registryFixture()
            );
            expectToolSequence(result, ['load_skill', 'WebFetch']);
            expect(approvalOf(result, 'WebFetch')).toBe('executed');
            expectStopReason(result, undefined);
            expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(skill.systemPrompt);
            expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain('Synthetic search evidence');
            await vi.waitFor(async () => {
                const reply = (await getConversationStore().get(sessionId))?.messages.at(-1);
                expect(reply?.parts).toContainEqual(
                    expect.objectContaining({
                        type: 'tool-WebFetch',
                        toolCallId: 'fetch',
                        state: 'output-available',
                        output: expect.objectContaining({ ok: true, content: 'Synthetic search evidence' })
                    })
                );
            });
        });

        it.each([
            new WebAccessError('EMPTY_CONTENT', '未抽取到可读正文'),
            new WebAccessError('TOO_LARGE', '响应超过上限'),
            new WebAccessError('HTTP_ERROR', 'HTTP 429', 429)
        ])('passes %s to model context and persistence without disguising it as success', async (error) => {
            state.fetch.mockRejectedValueOnce(error);
            const model = scriptedModel([
                { toolCalls: [{ name: 'load_skill', input: { skillId: meta.id } }] },
                { toolCalls: [{ name: 'WebFetch', input: { url: 'https://search.invalid/' }, id: 'failed-fetch' }] },
                { text: '场景结束。' }
            ]);
            state.model = model;
            const sessionId = randomUUID();
            const result = await runScenarioTurn(
                { messages: [userMessage('使用技能查询近期公开信息')], sessionId, agentMode },
                registryFixture()
            );
            expectToolSequence(result, ['load_skill', 'WebFetch']);
            // 工具正常产出业务失败不等于审批拒绝；这里只验证编排和证据传递，不用脚本文本证明模型事实性。
            expect(approvalOf(result, 'WebFetch')).toBe('executed');
            expectStopReason(result, undefined);
            const output = result.chunks.find(
                (chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'failed-fetch'
            );
            expect(output).toMatchObject({ output: { ok: false, code: error.code, status: error.status } });
            const nextPrompt = JSON.stringify(model.doStreamCalls[2].prompt);
            expect(nextPrompt).toContain(error.code);
            expect(nextPrompt).toContain(error.message);
            expect(nextPrompt).not.toContain('Synthetic search evidence');
            expect(state.fetch).toHaveBeenCalledOnce();
            await vi.waitFor(async () => {
                const reply = (await getConversationStore().get(sessionId))?.messages.at(-1);
                expect(reply?.parts).toContainEqual(
                    expect.objectContaining({
                        type: 'tool-WebFetch',
                        toolCallId: 'failed-fetch',
                        state: 'output-available',
                        output: expect.objectContaining({ ok: false, code: error.code })
                    })
                );
            });
        });

        it('stops consecutive structured WebFetch failures even when request URLs differ', async () => {
            state.fetch.mockRejectedValue(new WebAccessError('EMPTY_CONTENT', '未抽取到可读正文'));
            const model = scriptedModel([
                { toolCalls: [{ name: 'load_skill', input: { skillId: meta.id } }] },
                ...['one', 'two', 'three'].map((path) => ({
                    toolCalls: [{ name: 'WebFetch', input: { url: `https://search.invalid/${path}` } }]
                }))
            ]);
            state.model = model;
            const sessionId = randomUUID();
            const result = await runScenarioTurn(
                { messages: [userMessage('查询来源')], sessionId, agentMode },
                registryFixture()
            );
            expectToolSequence(result, ['load_skill', 'WebFetch', 'WebFetch', 'WebFetch']);
            expectStopReason(result, 'repeated-error');
            expect(result.metadata?.steps).toBe(4);
            expect(state.fetch).toHaveBeenCalledTimes(3);
            expect(model.doStreamCalls).toHaveLength(4);
            expect(JSON.stringify(model.doStreamCalls[3].prompt)).toContain('连续失败 2 次');
            await vi.waitFor(async () => {
                const reply = (await getConversationStore().get(sessionId))?.messages.at(-1);
                expect(reply?.metadata).toMatchObject({ stopReason: 'repeated-error', steps: 4 });
            });
        });
    });

    it.each(['deny', 'ask'] as const)('preserves %s policy for the repaired load_skill call', async (decision) => {
        await getPermissionStore().setRules({ deny: [], ask: [], allow: [], [decision]: ['load_skill'] });
        state.model = scriptedModel([{ toolCalls: [{ name: meta.id, input: {} }] }, { text: '技能尚未加载。' }]);
        const registry = registryFixture();
        const sessionId = randomUUID();
        const result = await runScenarioTurn({ messages: [userMessage('加载搜索技能')], sessionId }, registry);
        expectToolSequence(result, ['load_skill']);
        expect(approvalOf(result, 'load_skill')).toBe(decision === 'deny' ? 'denied' : 'requested');
        expect(registry.get).not.toHaveBeenCalled();
        expect(state.fetch).not.toHaveBeenCalled();
        // onEnd 落库异步于流结束；等到当前轮持久化完成，避免临时 HOME 清理与写盘竞争。
        await vi.waitFor(async () => {
            expect((await getConversationStore().get(sessionId))?.messages.at(-1)?.role).toBe('assistant');
        });
    });
});

describe('scenario: user skill resources in the default workspace', () => {
    const userMeta: SkillMetadata = {
        ...meta,
        id: 'script-search',
        dirPath: path.join(process.env.SKILLS_USER_DIR!, 'script-search'),
        source: 'user',
        editable: true
    };
    const userSkill: LoadedSkill = {
        ...skill,
        id: userMeta.id,
        systemPrompt: '运行 python scripts/search.py "<query>"'
    };

    function userRegistry() {
        const registry = fakeRegistry();
        registry.getCatalog = () => `## 可用技能\n- ${userMeta.id}: ${userMeta.description}`;
        registry.getMetadataById = (id) => (id === userMeta.id ? userMeta : undefined);
        registry.listMetadata = () => [userMeta];
        registry.get = vi.fn(async () => userSkill);
        registry.loadEnabled = async () => [userSkill];
        registry.getSkillsDir = () => process.env.SKILLS_USER_DIR!;
        registry.getUserSkillDirNames = () => ({ enabled: ['script-search'], disabled: [] });
        registry.listResourceFiles = async () => ['references/engines.md', 'scripts/search.py', 'tools/index.js'];
        return registry;
    }

    beforeEach(async () => {
        await fs.rm(path.join(WORKSPACE_DIR, 'script-search'), { recursive: true, force: true });
        for (const [file, content] of Object.entries({
            'SKILL.md': '# script search',
            'references/engines.md': 'engines',
            'scripts/search.py': 'print("synthetic search")',
            'tools/index.js': 'export default {}'
        })) {
            await fs.mkdir(path.dirname(path.join(userMeta.dirPath, file)), { recursive: true });
            await fs.writeFile(path.join(userMeta.dirPath, file), content);
        }
    });

    // 回归会话 0cef64d1：工作区只有同名 .md 副本时，模型在 cwd 下找不到 scripts/*.py。
    it('returns the complete workspace copy so the model can reach bundled scripts by relative path', async () => {
        const model = scriptedModel([
            { toolCalls: [{ name: 'load_skill', input: { skillId: userMeta.id }, id: 'load' }] },
            { toolCalls: [{ name: 'Read', input: { path: 'script-search/scripts/search.py' }, id: 'read' }] },
            { text: '脚本可用。' }
        ]);
        state.model = model;
        const sessionId = randomUUID();
        const result = await runScenarioTurn(
            { messages: [userMessage('用脚本搜索')], sessionId, agentMode: 'routed' },
            userRegistry()
        );
        expectToolSequence(result, ['load_skill', 'Read']);
        expect(approvalOf(result, 'Read')).toBe('executed');
        const loaded = result.chunks.find(
            (chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'load'
        );
        expect(loaded).toMatchObject({
            output: {
                directory: path.join(WORKSPACE_DIR, 'script-search'),
                files: ['references/engines.md', 'scripts/search.py']
            }
        });
        expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain('synthetic search');
        await expect(fs.stat(path.join(WORKSPACE_DIR, 'script-search/tools'))).rejects.toMatchObject({
            code: 'ENOENT'
        });
        await vi.waitFor(async () => {
            expect((await getConversationStore().get(sessionId))?.messages.at(-1)?.role).toBe('assistant');
        });
    });
});
