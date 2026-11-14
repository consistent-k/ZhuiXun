import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createModel } from '@/agent/model/provider';
import { createSubagentTools } from '@/agent/tools/subagent-tools';
import type { ResolvedModel } from '@/config/types';
import type { SkillRegistry } from '@/modules/skills';

vi.mock('@/agent/model/provider', () => ({ createModel: vi.fn() }));

const options = { toolCallId: 'subagent-call', messages: [], context: {} };
const modelConfig: ResolvedModel = {
    kind: 'openai-compatible',
    baseURL: 'https://model.invalid',
    apiKey: 'synthetic',
    modelName: 'fake-model'
};
const usage: LanguageModelV4GenerateResult['usage'] = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
};

function textResult(text: string): LanguageModelV4GenerateResult {
    return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: []
    };
}

function fixture(shellTools: ToolSet = {}) {
    const fake = {
        getCatalog: vi.fn(() => '## Synthetic skill catalog'),
        listMetadata: vi.fn(() => []),
        getMetadataById: vi.fn<SkillRegistry['getMetadataById']>(() => undefined),
        get: vi.fn<SkillRegistry['get']>(),
        listResourceFiles: vi.fn<SkillRegistry['listResourceFiles']>(async () => ['references/guide.md'])
    };
    const tools = createSubagentTools({
        registry: fake as unknown as SkillRegistry,
        modelConfig,
        shellTools,
        sessionId: 'test-session'
    });
    return { fake, tools };
}

async function execute(tools: ToolSet, description = 'Investigate') {
    return tools.Task.execute!({ description, prompt: 'Find synthetic evidence', subagent_type: 'explorer' }, options);
}

describe('agent Task execute using a real ToolLoopAgent and fake model', () => {
    it('only exposes read-only tools, actually invokes a nested read and returns only final text', async () => {
        const read = vi.fn(async ({ path }: { path: string }) => `evidence:${path}`);
        const Read = tool({ inputSchema: z.object({ path: z.string() }), execute: read });
        const harmless = tool({ inputSchema: z.object({}), execute: async () => 'unused' });
        const f = fixture({
            Read,
            Grep: harmless,
            Glob: harmless,
            LS: harmless,
            Bash: harmless,
            Write: harmless,
            Edit: harmless,
            Task: harmless,
            askUserQuestion: harmless,
            write_memory: harmless,
            mcp_write: harmless
        });
        const model = new MockLanguageModelV4({
            doGenerate: [
                {
                    content: [
                        { type: 'tool-call', toolCallId: 'nested-read', toolName: 'Read', input: '{"path":"code.ts"}' }
                    ],
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage,
                    warnings: []
                },
                textResult('Conclusion: code.ts contains synthetic evidence')
            ]
        });
        vi.mocked(createModel).mockReturnValue(model);
        expect(await execute(f.tools)).toEqual({
            description: 'Investigate',
            result: 'Conclusion: code.ts contains synthetic evidence'
        });
        expect(createModel).toHaveBeenLastCalledWith(modelConfig);
        expect(read).toHaveBeenCalledOnce();
        expect(read.mock.calls[0][0]).toEqual({ path: 'code.ts' });
        expect(model.doGenerateCalls).toHaveLength(2);
        expect(model.doGenerateCalls[0].tools?.map((t) => t.name)).toEqual([
            'load_skill',
            'list_skills',
            'Read',
            'Grep',
            'Glob',
            'LS'
        ]);
        expect(model.doGenerateCalls[0].prompt[0]).toMatchObject({
            role: 'system',
            content: expect.stringContaining('Synthetic skill catalog')
        });
        expect(model.doGenerateCalls[0].prompt).toContainEqual({
            role: 'user',
            content: [{ type: 'text', text: 'Find synthetic evidence' }]
        });
        expect(model.doGenerateCalls[1].prompt).toContainEqual(expect.objectContaining({ role: 'tool' }));
    });

    it('handles a sparse parent toolset and can execute readonly skill metadata', async () => {
        const f = fixture();
        const model = new MockLanguageModelV4({
            doGenerate: [
                {
                    content: [{ type: 'tool-call', toolCallId: 'nested-list', toolName: 'list_skills', input: '{}' }],
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage,
                    warnings: []
                },
                textResult('No skills available')
            ]
        });
        vi.mocked(createModel).mockReturnValue(model);
        expect(await execute(f.tools)).toEqual({ description: 'Investigate', result: 'No skills available' });
        expect(f.fake.listMetadata).toHaveBeenCalledOnce();
        expect(model.doGenerateCalls[0].tools?.map((t) => t.name)).toEqual(['load_skill', 'list_skills']);
    });

    it('repairs a skill id in a nested SDK loop without exposing unmounted code tools', async () => {
        const Read = tool({ inputSchema: z.object({ path: z.string() }), execute: async () => 'resource evidence' });
        const f = fixture({ Read });
        f.fake.getMetadataById.mockReturnValue({
            id: 'shared-skill',
            name: 'Shared skill',
            description: 'Synthetic',
            dirPath: '/synthetic/shared-skill',
            loaded: false,
            disabled: false,
            source: 'builtin',
            editable: false
        });
        f.fake.get.mockResolvedValue({
            id: 'shared-skill',
            name: 'Shared skill',
            description: 'Synthetic',
            systemPrompt: 'Read references/guide.md as needed.',
            tools: { Read, custom_write: Read },
            toolInfo: []
        });
        const model = new MockLanguageModelV4({
            doGenerate: [
                {
                    content: [{ type: 'tool-call', toolCallId: 'nested-skill', toolName: 'shared-skill', input: '{}' }],
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage,
                    warnings: []
                },
                textResult('Shared instructions loaded')
            ]
        });
        vi.mocked(createModel).mockReturnValue(model);
        expect(await execute(f.tools)).toEqual({ description: 'Investigate', result: 'Shared instructions loaded' });
        const toolMessage = model.doGenerateCalls[1].prompt.find((message) => message.role === 'tool');
        expect(toolMessage).toMatchObject({
            content: [
                {
                    toolName: 'load_skill',
                    toolCallId: 'nested-skill',
                    output: {
                        type: 'json',
                        value: {
                            instructions: 'Read references/guide.md as needed.',
                            availableTools: ['Read'],
                            directory: '/synthetic/shared-skill',
                            files: ['references/guide.md']
                        }
                    }
                }
            ]
        });
        expect(model.doGenerateCalls[1].tools?.map((entry) => entry.name)).not.toContain('custom_write');
    });

    it.each([new Error('fake model failure'), 'non-error failure'])(
        'structures model failures %s without throwing',
        async (error) => {
            const f = fixture();
            const model = new MockLanguageModelV4({
                doGenerate: async () => {
                    throw error;
                }
            });
            vi.mocked(createModel).mockReturnValue(model);
            expect(await execute(f.tools)).toEqual({
                description: 'Investigate',
                error: `子任务执行失败：${error instanceof Error ? error.message : error}`
            });
        }
    );

    it('enforces the 25-step budget for a model repeatedly calling read-only tools', async () => {
        const f = fixture();
        const model = new MockLanguageModelV4({
            doGenerate: async () => ({
                content: [{ type: 'tool-call', toolCallId: 'loop-list', toolName: 'list_skills', input: '{}' }],
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
                warnings: []
            })
        });
        vi.mocked(createModel).mockReturnValue(model);
        expect(await execute(f.tools)).toEqual({ description: 'Investigate', result: '' });
        expect(model.doGenerateCalls).toHaveLength(25);
        expect(f.fake.listMetadata).toHaveBeenCalledTimes(25);
    });
});
