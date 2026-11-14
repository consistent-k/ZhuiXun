import {
    InvalidToolInputError,
    NoSuchToolError,
    ToolLoopAgent,
    stepCountIs,
    tool,
    type ToolCallRepairFunction,
    type ToolSet
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createApprovalPipeline } from '@/agent/tools/approval-pipeline';
import { wrapToolsWithHooks } from '@/agent/tools/hook-wrapper';
import { createSkillCallRepair } from '@/agent/tools/skill-call-repair';
import type { SkillMetadata } from '@/modules/skills';

const meta: SkillMetadata = {
    id: 'multi-search-engine',
    name: 'Search workflow',
    description: 'Synthetic search instructions',
    dirPath: '/synthetic/skills/multi-search-engine',
    loaded: false,
    source: 'builtin',
    editable: false,
    disabled: false
};
const load = { inputSchema: z.object({ skillId: z.string() }) };
type RepairInput = Parameters<ToolCallRepairFunction<ToolSet>>[0];
function input(overrides: Partial<RepairInput> = {}): RepairInput {
    return {
        toolCall: { type: 'tool-call', toolCallId: 'original-call', toolName: meta.id, input: '{"query":"synthetic"}' },
        tools: { load_skill: load },
        error: new NoSuchToolError({ toolName: meta.id }),
        instructions: undefined,
        // AI SDK 7 的修复回调仍要求同时提供 system 与 instructions，保留必填兼容字段。
        system: undefined,
        messages: [],
        inputSchema: async () => ({}),
        ...overrides
    };
}

describe('skill call repair', () => {
    it('repairs an exact enabled skill id without executing anything and preserves call identity', async () => {
        const getMetadataById = vi.fn(() => meta);
        const original = input();
        const repaired = await createSkillCallRepair({ getMetadataById, listMetadata: () => [meta] })(original);
        expect(repaired).toEqual({
            ...original.toolCall,
            toolName: 'load_skill',
            input: JSON.stringify({ skillId: meta.id })
        });
        expect(getMetadataById).toHaveBeenCalledExactlyOnceWith(meta.id);
        expect(original.toolCall.toolName).toBe(meta.id);
    });

    it.each([undefined, { ...meta, disabled: true }, { ...meta, id: 'another-skill' }])(
        'does not repair missing, disabled or non-exact metadata %j',
        async (value) => {
            const repair = createSkillCallRepair({ getMetadataById: () => value, listMetadata: () => [] });
            expect(await repair(input())).toBeNull();
        }
    );

    it.each(['multi-search_engine', 'MULTI_SEARCH_ENGINE', 'Multi-Search-Engine'])(
        'repairs %s that only differs by case or _/- to the unique enabled skill',
        async (toolName) => {
            const repair = createSkillCallRepair({ getMetadataById: () => undefined, listMetadata: () => [meta] });
            const original = input({
                toolCall: { ...input().toolCall, toolName },
                error: new NoSuchToolError({ toolName })
            });
            expect(await repair(original)).toEqual({
                ...original.toolCall,
                toolName: 'load_skill',
                input: JSON.stringify({ skillId: meta.id })
            });
        }
    );

    it.each([
        ['disabled match', [{ ...meta, disabled: true }]],
        ['ambiguous matches', [meta, { ...meta, id: 'multi_search_engine' }]],
        ['other edits beyond _/-', [{ ...meta, id: 'multi-search-engines' }]]
    ])('does not guess a normalized name for %s', async (_label, list) => {
        const toolName = 'multi-search_engine';
        const repair = createSkillCallRepair({ getMetadataById: () => undefined, listMetadata: () => list });
        expect(
            await repair(
                input({ toolCall: { ...input().toolCall, toolName }, error: new NoSuchToolError({ toolName }) })
            )
        ).toBeNull();
    });

    it.each<Partial<RepairInput>>([
        { tools: {} },
        { tools: { load_skill: load, [meta.id]: load } },
        { toolCall: { ...input().toolCall, providerExecuted: true } },
        {
            error: new InvalidToolInputError({ toolName: meta.id, toolInput: '{}', cause: new Error('bad input') })
        }
    ])('leaves unrelated SDK failures and provider-owned calls unchanged: %j', async (overrides) => {
        const getMetadataById = vi.fn(() => meta);
        expect(
            await createSkillCallRepair({ getMetadataById, listMetadata: () => [meta] })(input(overrides))
        ).toBeNull();
        expect(getMetadataById).not.toHaveBeenCalled();
    });
});

describe('SDK repaired calls retain hooks', () => {
    it.each(['allow', 'deny'] as const)(
        'passes the repaired input through PreToolUse %s and PostToolUse',
        async (decision) => {
            const execute = vi.fn(async () => ({ success: true }));
            const hooks = {
                matches: () => true,
                pre: vi.fn(async () => ({ decision })),
                post: vi.fn(async () => ({ additionalContext: 'verified by hook' }))
            };
            const tools = wrapToolsWithHooks(
                {
                    load_skill: tool({ inputSchema: z.object({ skillId: z.string() }), execute })
                },
                hooks
            );
            const usage = {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 }
            };
            const model = new MockLanguageModelV4({
                doGenerate: [
                    {
                        content: [input().toolCall],
                        finishReason: { unified: 'tool-calls', raw: undefined },
                        usage,
                        warnings: []
                    },
                    {
                        content: [{ type: 'text', text: 'done' }],
                        finishReason: { unified: 'stop', raw: undefined },
                        usage,
                        warnings: []
                    }
                ]
            });
            const agent = new ToolLoopAgent({
                model,
                tools,
                repairToolCall: createSkillCallRepair({ getMetadataById: () => meta, listMetadata: () => [meta] }),
                toolApproval: createApprovalPipeline({
                    hooks,
                    fallback: () => 'not-applicable',
                    hasUi: true,
                    danger: false
                }),
                stopWhen: stepCountIs(3)
            });
            await agent.generate({ prompt: 'Use the skill' });
            expect(hooks.pre).toHaveBeenCalledExactlyOnceWith({ toolName: 'load_skill', input: { skillId: meta.id } });
            if (decision === 'deny') {
                expect(execute).not.toHaveBeenCalled();
                expect(hooks.post).not.toHaveBeenCalled();
            } else {
                expect(execute).toHaveBeenCalledOnce();
                expect(hooks.post).toHaveBeenCalledExactlyOnceWith(
                    { toolName: 'load_skill', input: { skillId: meta.id }, toolCallId: 'original-call' },
                    { success: true }
                );
                expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('verified by hook');
            }
        }
    );
});
