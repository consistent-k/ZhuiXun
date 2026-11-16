import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { ToolLoopAgent, type UIMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    forceCompactContext,
    maybeCompactContext,
    reactiveCompactContext,
    withReactiveCompaction
} from '@/agent/compaction';
import { compactionUsageScope, type CompactContextParams } from '@/agent/compaction/compactor';
import { CLEARED_TOOL_OUTPUT } from '@/agent/compaction/microcompact';
import { generateCompactionSummary } from '@/agent/compaction/summarizer';
import { estimateMessagesTokens } from '@/agent/compaction/token-estimate';
import { createModel } from '@/agent/model/provider';
import type { ResolvedModel } from '@/config/types';
import type { CompactionCheckpoint } from '@/modules/conversations';

const settings = vi.hoisted(() => ({ autoCompactEnabled: true, autoCompactThreshold: 80 }));
vi.mock('@/config/settings-store', () => ({ getAppSettings: () => settings }));
vi.mock('@/agent/model/provider', () => ({ createModel: vi.fn() }));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

const model: ResolvedModel = {
    kind: 'openai-compatible',
    modelName: 'fake',
    apiKey: '',
    baseURL: 'https://unused.invalid',
    contextWindow: 100_000
};
const usage: LanguageModelV4GenerateResult['usage'] = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 }
};
let sdkModel: MockLanguageModelV4;
let sequence = 0;

function generated(text = '  事实：保留 12 mg 与 /sandbox/a；待办：复查。  '): LanguageModelV4GenerateResult {
    return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: []
    };
}

function messages(count = 8): UIMessage[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `内容${i}` }]
    }));
}

function checkpoint(overrides: Partial<CompactionCheckpoint> = {}): CompactionCheckpoint {
    return {
        summary: '旧摘要',
        boundaryMessageId: 'm2',
        createdAt: 1,
        summarizedCount: 2,
        tokensBefore: 100_000,
        ...overrides
    };
}

function fixture(input = messages(), cp?: CompactionCheckpoint, persistedMessages?: UIMessage[]) {
    const latest = [...input].reverse().find((message) => message.role === 'assistant');
    const scope = compactionUsageScope(
        model,
        cp && input.findIndex((m) => m.id === cp.boundaryMessageId) > 0 ? cp : undefined
    );
    const persisted =
        persistedMessages ??
        (latest ? [{ ...latest, metadata: { compactionUsageScope: scope, usage: { totalTokens: 100_000 } } }] : []);
    let saved = cp;
    const get = vi.fn(async () => ({ messages: persisted, compaction: saved }));
    const updateCompaction = vi.fn(async (_sessionId: string, next: CompactionCheckpoint, _commit: unknown) => {
        saved = next;
        return true;
    });
    const params: CompactContextParams = {
        store: { get, updateCompaction } as unknown as CompactContextParams['store'],
        sessionId: `compaction-test-${++sequence}`,
        messages: input,
        model,
        onCompacting: vi.fn()
    };
    return { params, get, updateCompaction };
}

beforeEach(() => {
    settings.autoCompactEnabled = true;
    settings.autoCompactThreshold = 80;
    sdkModel = new MockLanguageModelV4({ doGenerate: generated() });
    vi.mocked(createModel).mockReset().mockReturnValue(sdkModel);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('summary generation through the real AI SDK', () => {
    it('skips empty transcripts before creating a model', async () => {
        await expect(generateCompactionSummary(' \n ', undefined, model)).resolves.toBeNull();
        expect(createModel).not.toHaveBeenCalled();
    });

    it('sends the exact transcript, prior summary, factual system instruction and generation budget to the model', async () => {
        await expect(
            generateCompactionSummary(' \n预算 12 万，文件 /sandbox/a \n', '既往日期 2026-01-01', model)
        ).resolves.toBe('事实：保留 12 mg 与 /sandbox/a；待办：复查。');
        expect(createModel).toHaveBeenCalledExactlyOnceWith(model);
        expect(sdkModel.doGenerateCalls).toHaveLength(1);
        const call = sdkModel.doGenerateCalls[0];
        expect(call.maxOutputTokens).toBe(2048);
        expect(call.temperature).toBe(0.3);
        expect(call.prompt[0]).toMatchObject({ role: 'system', content: expect.stringContaining('不得四舍五入') });
        expect(call.prompt[1]).toEqual({
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: '【已有摘要】\n既往日期 2026-01-01\n\n【需要并入摘要的对话记录】\n预算 12 万，文件 /sandbox/a\n\n请输出更新后的完整摘要。'
                }
            ]
        });
    });

    it('omits an absent prior summary and returns null for whitespace-only or failed model responses', async () => {
        sdkModel.doGenerate = async () => generated('   ');
        await expect(generateCompactionSummary('new', undefined, model)).resolves.toBeNull();
        sdkModel.doGenerate = async () => {
            throw new Error('fake provider failed');
        };
        await expect(generateCompactionSummary('new', undefined, model)).resolves.toBeNull();
        vi.mocked(createModel).mockImplementation(() => {
            throw new Error('model unavailable');
        });
        await expect(generateCompactionSummary('new', undefined, model)).resolves.toBeNull();
    });
});

describe('cross-turn compaction orchestration', () => {
    it('applies an existing checkpoint while skipping new automatic compression when disabled', async () => {
        settings.autoCompactEnabled = false;
        const f = fixture(messages(), checkpoint());
        for (const compact of [maybeCompactContext, reactiveCompactContext]) {
            const result = await compact(f.params);
            expect(result.changed).toBe(false);
            expect(result.modelInput[0].id).toBe('m2');
            expect(result.modelInput[0].parts[0]).toMatchObject({ text: expect.stringContaining('旧摘要') });
        }
        expect(f.updateCompaction).not.toHaveBeenCalled();
        expect(createModel).not.toHaveBeenCalled();
    });

    it('manual /compact ignores the setting and threshold and forwards user instructions to the summarizer', async () => {
        settings.autoCompactEnabled = false;
        const f = fixture(messages(), undefined, []);
        const outcome = await forceCompactContext({ ...f.params, instructions: '  保留方案结论  ' });
        expect(outcome.changed).toBe(true);
        expect(outcome.marker).toMatchObject({ summarizedCount: expect.any(Number) });
        expect(f.updateCompaction).toHaveBeenCalledOnce();
        const prompt = JSON.stringify(sdkModel.doGenerateCalls[0].prompt);
        expect(prompt).toContain('【用户对本次摘要的额外要求】');
        expect(prompt).toContain('保留方案结论');
        // 无可压缩内容（消息过少）：不调用模型
        const tiny = fixture(messages(2), undefined, []);
        expect(await forceCompactContext(tiny.params)).toMatchObject({ changed: false });
        expect(sdkModel.doGenerateCalls).toHaveLength(1);
    });

    it('summarizes only the head, persists checkpoint before using it, and never mutates raw messages', async () => {
        const f = fixture();
        const snapshot = structuredClone(f.params.messages);
        const outcome = await maybeCompactContext(f.params);
        expect(outcome.changed).toBe(true);
        expect(outcome.marker).toMatchObject({ summarizedCount: 6, keptCount: 2, tokensBefore: 100_000 });
        expect(outcome.marker?.tokensAfter).toBe(estimateMessagesTokens(outcome.modelInput));
        expect(outcome.modelInput.map((m) => m.id)).toEqual(['m6', 'm7']);
        expect(outcome.modelInput[0].role).toBe('user');
        expect(outcome.modelInput[0].parts).toEqual([
            { type: 'text', text: expect.stringContaining('事实：保留 12 mg') },
            ...snapshot[6].parts
        ]);
        expect(outcome.modelInput[1]).toBe(f.params.messages[7]);
        expect(f.updateCompaction).toHaveBeenCalledWith(
            f.params.sessionId,
            expect.objectContaining({
                summary: '事实：保留 12 mg 与 /sandbox/a；待办：复查。',
                boundaryMessageId: 'm6',
                summarizedCount: 6,
                createdAt: expect.any(Number),
                tokensBefore: 100_000
            }),
            expect.objectContaining({ expected: expect.any(Object) })
        );
        expect(f.params.onCompacting).toHaveBeenCalledOnce();
        const prompt = JSON.stringify(sdkModel.doGenerateCalls[0].prompt);
        expect(prompt).toContain('用户：内容0');
        expect(prompt).toContain('助手：内容5');
        expect(prompt).not.toContain('内容6');
        expect(prompt).not.toContain('【已有摘要】');
        expect(f.params.messages).toEqual(snapshot);
    });

    it('reuses existing checkpoints below the threshold and rolls only the new head into a full replacement summary', async () => {
        const cp = checkpoint();
        const low = fixture(messages(), cp, []);
        const reused = await maybeCompactContext(low.params);
        expect(reused.modelInput.map((m) => m.id)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7']);
        expect(reused.modelInput[0].parts[0]).toMatchObject({ text: expect.stringContaining('旧摘要') });
        expect(reused.marker).toBeUndefined();
        expect(low.updateCompaction).not.toHaveBeenCalled();
        expect(createModel).not.toHaveBeenCalled();
        const high = fixture(messages(), cp);
        const rolled = await maybeCompactContext(high.params);
        expect(rolled.marker).toMatchObject({ summarizedCount: 4, keptCount: 2 });
        expect(high.updateCompaction).toHaveBeenCalledWith(
            high.params.sessionId,
            expect.objectContaining({ summarizedCount: 6 }),
            expect.any(Object)
        );
        const prompt = JSON.stringify(sdkModel.doGenerateCalls[0].prompt);
        expect(prompt).toContain('【已有摘要】');
        expect(prompt).toContain('旧摘要');
        expect(prompt).toContain('内容2');
        expect(prompt).not.toContain('内容0');
    });

    it.each(['missing', 'm0'])('ignores a stale checkpoint with boundary %s', async (boundaryMessageId) => {
        const f = fixture(messages(), checkpoint({ boundaryMessageId }));
        expect((await maybeCompactContext(f.params)).marker?.summarizedCount).toBe(6);
        expect(JSON.stringify(sdkModel.doGenerateCalls[0].prompt)).not.toContain('旧摘要');
        expect(f.updateCompaction).toHaveBeenCalledWith(
            f.params.sessionId,
            expect.objectContaining({ summarizedCount: 6 }),
            expect.any(Object)
        );
    });

    it('leaves input alone when history is absent or its estimated usage is below threshold', async () => {
        const f = fixture(messages(), undefined, []);
        f.get.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof f.get>>);
        expect(await maybeCompactContext(f.params)).toMatchObject({ modelInput: f.params.messages, changed: false });
        expect(createModel).not.toHaveBeenCalled();
    });

    it.each([
        { usage: { totalTokens: 100_000 } },
        { usage: { totalTokens: 0, inputTokens: 99_999, outputTokens: 1 } },
        { usage: { inputTokens: 100_000 } },
        { usage: { outputTokens: 100_000 } }
    ])(
        'uses the most recent assistant usage rather than an earlier step or accumulated history: %j',
        async (metadata) => {
            const input = messages(6);
            input[3].metadata = { usage: { totalTokens: 1_000_000 } };
            input[5].metadata = { ...metadata, compactionUsageScope: compactionUsageScope(model) };
            input.push({ id: 'new-user', role: 'user', parts: [{ type: 'text', text: '新问题' }] });
            const f = fixture(input, undefined, [{ id: 'u', role: 'user', parts: [] }]);
            const result = await maybeCompactContext(f.params);
            expect(result.marker?.tokensBefore).toBe(100_000 + estimateMessagesTokens(input.slice(6)));
            expect(createModel).toHaveBeenCalledOnce();
        }
    );

    it.each([undefined, {}, { usage: {} }, { usage: { totalTokens: -1, inputTokens: 0, outputTokens: 0 } }])(
        'falls back to character estimates for unusable latest metadata %j',
        async (metadata) => {
            const input = messages();
            input[1].metadata = { usage: { totalTokens: 1_000_000 } };
            input[7].metadata = metadata;
            const f = fixture(input, undefined, []);
            expect((await maybeCompactContext(f.params)).changed).toBe(false);
            expect(createModel).not.toHaveBeenCalled();
        }
    );

    it('ignores usage outside the current prompt and can trigger with character estimates alone', async () => {
        const input = messages().map((m) => ({ ...m, role: 'user' as const }));
        const f = fixture(input, undefined, [
            {
                id: 'unrelated',
                role: 'assistant',
                parts: [],
                metadata: { compactionUsageScope: compactionUsageScope(model), usage: { totalTokens: 100_000 } }
            }
        ]);
        expect((await maybeCompactContext(f.params)).marker).toBeUndefined();
        const large = fixture(
            messages().map((m) => ({ ...m, parts: [{ type: 'text' as const, text: '字'.repeat(20_000) }] })),
            undefined,
            []
        );
        expect((await maybeCompactContext(large.params)).marker?.tokensBefore).toBe(160_032);
    });

    it('microcompacts before summarizing and avoids double-discounting previously cleared output in stored usage', async () => {
        const input = messages(14).map((m, i) => ({
            ...m,
            parts: [
                {
                    type: 'tool-Read',
                    toolCallId: `t${i}`,
                    state: 'output-available',
                    input: {},
                    output: 'x'.repeat(40_000)
                }
            ]
        })) as UIMessage[];
        const smallUsage = fixture(input, undefined, [
            {
                ...input[13],
                metadata: { compactionUsageScope: compactionUsageScope(model), usage: { totalTokens: 60_000 } }
            }
        ]);
        const micro = await maybeCompactContext(smallUsage.params);
        expect(micro.changed).toBe(true);
        expect(micro.marker).toBeUndefined();
        expect(micro.modelInput[0].parts[0]).toMatchObject({ output: CLEARED_TOOL_OUTPUT });
        expect(createModel).not.toHaveBeenCalled();
        const highUsage = fixture(input);
        const summarized = await maybeCompactContext(highUsage.params);
        expect(summarized.marker?.tokensBefore).toBe(100_000);
        expect(createModel).toHaveBeenCalledOnce();
        const rolling = fixture(input, checkpoint());
        expect((await maybeCompactContext(rolling.params)).marker?.tokensBefore).toBe(100_000);
        expect(rolling.updateCompaction).toHaveBeenCalledWith(
            rolling.params.sessionId,
            expect.objectContaining({ summarizedCount: 10 }),
            expect.any(Object)
        );
        const failing = fixture(input, checkpoint());
        sdkModel.doGenerate = async () => generated(' ');
        const fallback = await maybeCompactContext(failing.params);
        expect(fallback.changed).toBe(true);
        expect(fallback.marker).toBeUndefined();
        expect(fallback.modelInput[0].id).toBe('m2');
        expect(fallback.modelInput[0].parts[0]).toMatchObject({ text: expect.stringContaining('旧摘要') });
        expect(fallback.modelInput[0].parts[1]).toMatchObject({ output: CLEARED_TOOL_OUTPUT });
        expect(failing.updateCompaction).not.toHaveBeenCalled();
    });

    it('uses estimated post-microcompaction size when no assistant usage is available', async () => {
        const input = messages(7).map((m, i) => ({
            ...m,
            role: 'user' as const,
            parts: [
                {
                    type: 'tool-Bash',
                    toolCallId: `t${i}`,
                    state: 'output-available',
                    input: {},
                    output: 'x'.repeat(8000)
                }
            ]
        })) as UIMessage[];
        const f = fixture(input);
        const result = await reactiveCompactContext(f.params);
        expect(result.marker?.tokensBefore).toBeLessThan(estimateMessagesTokens(input));
    });

    it('ignores historical usage after a model or checkpoint change', async () => {
        const changedModel = fixture();
        changedModel.params.model = { ...model, modelName: 'other-model' };
        expect((await maybeCompactContext(changedModel.params)).marker).toBeUndefined();
        const changedCheckpoint = fixture(messages(), checkpoint(), [
            {
                ...messages()[7],
                metadata: { usage: { totalTokens: 100_000 }, compactionUsageScope: compactionUsageScope(model) }
            }
        ]);
        expect((await maybeCompactContext(changedCheckpoint.params)).marker).toBeUndefined();
        expect(createModel).not.toHaveBeenCalled();
    });

    it('skips overflow retries when microcompaction produces the same failed input', async () => {
        const input = messages(14);
        for (const message of input) {
            message.parts = [
                {
                    type: 'tool-Read',
                    toolCallId: message.id,
                    state: 'output-available',
                    input: {},
                    output: 'a'.repeat(40_000)
                }
            ];
        }
        const f = fixture(input, undefined, []);
        const first = await maybeCompactContext(f.params);
        expect(first.changed).toBe(true);
        expect(first.marker).toBeUndefined();
        // 摘要失败时，反应式压缩只能退回到已经发送过的微压缩输入。
        sdkModel.doGenerate = async () => generated(' ');
        const retry = await reactiveCompactContext(f.params, first.modelInput);
        expect(retry.changed).toBe(false);
        expect(retry.modelInput).toEqual(first.modelInput);
        expect(f.updateCompaction).not.toHaveBeenCalled();
    });

    it('does not commit partially summarized history if a later batch fails', async () => {
        const input = messages(4);
        input[0].parts = [{ type: 'text', text: '字'.repeat(30_000) }];
        const f = fixture(input);
        sdkModel = new MockLanguageModelV4({ doGenerate: [generated(), generated(' ')] });
        vi.mocked(createModel).mockReturnValue(sdkModel);
        expect((await maybeCompactContext(f.params)).marker).toBeUndefined();
        expect(sdkModel.doGenerateCalls).toHaveLength(2);
        expect(f.updateCompaction).not.toHaveBeenCalled();
    });

    it('batches oversized history in order and retains bounded tool evidence and file annotations', async () => {
        const input = messages(4);
        input[0].parts = [
            { type: 'text', text: 'original-requirement' + 'a'.repeat(25_000) },
            { type: 'tool-Read', output: 'data' },
            { type: 'file' }
        ] as UIMessage['parts'];
        input[1].parts = [{ type: 'text' }, { type: 'text', text: 'tail' }] as UIMessage['parts'];
        const f = fixture(input);
        await maybeCompactContext(f.params);
        expect(sdkModel.doGenerateCalls).toHaveLength(2);
        const [first, second] = sdkModel.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
        expect(first).toContain('original-requirement');
        expect(second).toContain('【已有摘要】');
        expect(second).toContain('[工具调用x1] [附件x1]');
        expect(second).toContain('Read | data');
        expect(second).toContain('助手：tail');
        expect(f.updateCompaction).toHaveBeenCalledOnce();
    });

    it.each(
        [
            messages(3),
            messages(4).map((m) => ({ ...m, role: 'assistant' as const })),
            messages(4).map((m, i) => ({ ...m, id: i === 2 ? '' : m.id })),
            messages(4).map((m) => ({ ...m, parts: [] })),
            messages(4).map((m) => ({ ...m, parts: undefined })) as unknown as UIMessage[]
        ].map((input) => ({ input }))
    )('does not summarize when no valid user boundary or transcript exists', async ({ input }) => {
        const f = fixture(input);
        expect(await reactiveCompactContext(f.params)).toMatchObject({ modelInput: input, changed: false });
        expect(f.params.onCompacting).not.toHaveBeenCalled();
        expect(createModel).not.toHaveBeenCalled();
    });

    it('keeps the existing summary when the boundary cannot advance, including an empty boundary message', async () => {
        const input = messages();
        input[6] = { ...input[6], parts: undefined } as unknown as UIMessage;
        const f = fixture(input, checkpoint({ boundaryMessageId: 'm6' }));
        const result = await reactiveCompactContext(f.params);
        expect(result.modelInput.map((m) => m.id)).toEqual(['m6', 'm7']);
        expect(result.modelInput[0].parts).toHaveLength(1);
        expect(result.marker).toBeUndefined();
        expect(createModel).not.toHaveBeenCalled();
    });

    it('snaps an estimated boundary to an earlier full user turn or a later user when too little head would remain', async () => {
        const earlier = messages(7);
        // 预算不足时先保留两条，边界 m5 是 assistant，因此向前吸附到 m4。
        const first = fixture(earlier);
        expect((await reactiveCompactContext(first.params)).modelInput[0].id).toBe('m4');
        const later = messages(6);
        later[2].role = 'assistant';
        later[3].role = 'user';
        later[5].parts = [{ type: 'text', text: '字'.repeat(30_000) }];
        const second = fixture(later);
        expect((await maybeCompactContext(second.params)).modelInput[0].id).toBe('m4');
        const forcedLater = messages(5);
        forcedLater[1].parts = [{ type: 'text', text: '字'.repeat(30_000) }];
        forcedLater[2].role = 'assistant';
        forcedLater[3].role = 'user';
        forcedLater[4].role = 'assistant';
        forcedLater[4].parts = [{ type: 'text', text: '字'.repeat(15_000) }];
        const third = fixture(forcedLater);
        expect((await maybeCompactContext(third.params)).modelInput[0].id).toBe('m3');
    });

    it('falls back to the existing input on summary or checkpoint persistence failure', async () => {
        const f = fixture();
        sdkModel.doGenerate = async () => generated('  ');
        expect(await maybeCompactContext(f.params)).toMatchObject({ modelInput: f.params.messages, changed: false });
        expect(f.updateCompaction).not.toHaveBeenCalled();
        sdkModel.doGenerate = async () => generated();
        f.updateCompaction.mockRejectedValue(new Error('disk full'));
        expect(await maybeCompactContext(f.params)).toMatchObject({ modelInput: f.params.messages, changed: false });
    });

    it('breaks after three consecutive failures per session, reactive mode bypasses it, and success resets it', async () => {
        const f = fixture();
        sdkModel.doGenerate = async () => generated(' ');
        for (let i = 0; i < 4; i++) await maybeCompactContext(f.params);
        expect(createModel).toHaveBeenCalledTimes(3);
        const another = fixture();
        await maybeCompactContext(another.params);
        expect(createModel).toHaveBeenCalledTimes(4);
        await reactiveCompactContext(f.params);
        expect(createModel).toHaveBeenCalledTimes(5);
        sdkModel.doGenerate = async () => generated();
        expect((await reactiveCompactContext(f.params)).changed).toBe(true);
        // 模拟历史被回滚，成功清零后应允许普通模式再次尝试。
        f.get.mockResolvedValue({
            messages: [
                {
                    ...f.params.messages[7],
                    metadata: { compactionUsageScope: compactionUsageScope(model), usage: { totalTokens: 100_000 } }
                }
            ],
            compaction: undefined
        });
        await maybeCompactContext(f.params);
        expect(createModel).toHaveBeenCalledTimes(7);
    });

    it('expires failure breakers after 30 minutes and prunes expired sessions when the map exceeds 200', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        sdkModel.doGenerate = async () => generated(' ');
        const f = fixture();
        for (let i = 0; i < 3; i++) await maybeCompactContext(f.params);
        vi.setSystemTime(1000 + 30 * 60_000 + 1);
        await maybeCompactContext(f.params);
        expect(createModel).toHaveBeenCalledTimes(4);
        for (let i = 0; i < 202; i++) await maybeCompactContext(fixture().params);
        vi.setSystemTime(1000 + 60 * 60_000 + 2);
        await maybeCompactContext(fixture().params);
        await maybeCompactContext(f.params);
        expect(createModel).toHaveBeenCalledTimes(208);
    });
});

function providerStream(parts: LanguageModelV4StreamPart[]) {
    return new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        }
    });
}

const healthyParts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: '恢复后的答案' },
    { type: 'text-end', id: 'answer' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }
];

describe('real SDK streaming with reactive compaction', () => {
    it('recovers a provider overflow by persisting a summary and retrying once with a genuinely smaller prompt', async () => {
        const provider = new MockLanguageModelV4({
            doStream: [
                {
                    stream: providerStream([
                        { type: 'stream-start', warnings: [] },
                        { type: 'error', error: new Error('context_length_exceeded') }
                    ])
                },
                { stream: providerStream(healthyParts) }
            ]
        });
        const agent = new ToolLoopAgent({ model: provider, maxRetries: 0 });
        const f = fixture();
        const retry = vi.fn(async () => {
            const compacted = await reactiveCompactContext(f.params);
            if (!compacted.changed) return null;
            const result = await agent.stream({
                messages: compacted.modelInput.map((m) => ({
                    role: m.role,
                    content: m.parts
                        .filter((p) => p.type === 'text')
                        .map((p) => p.text)
                        .join('\n')
                }))
            });
            return result.stream;
        });
        const wrapped = withReactiveCompaction(agent, retry);
        const result = await wrapped.stream({
            messages: f.params.messages.map((m) => ({ role: m.role, content: `原始消息 ${m.id}` }))
        });
        const parts = [];
        for await (const part of result.stream) parts.push(part);
        expect(
            parts
                .filter((p) => p.type === 'text-delta')
                .map((p) => p.text)
                .join('')
        ).toBe('恢复后的答案');
        expect(parts.some((p) => p.type === 'error')).toBe(false);
        expect(parts.filter((p) => p.type === 'start')).toHaveLength(1);
        expect(retry).toHaveBeenCalledOnce();
        expect(provider.doStreamCalls).toHaveLength(2);
        expect(provider.doStreamCalls[0].prompt).toHaveLength(8);
        expect(provider.doStreamCalls[1].prompt).toHaveLength(2);
        expect(JSON.stringify(provider.doStreamCalls[1].prompt)).toContain('事实：保留 12 mg');
        expect(f.updateCompaction).toHaveBeenCalledOnce();
        expect(sdkModel.doGenerateCalls).toHaveLength(1);
    });

    it('reports the original overflow when a one-message conversation has no compressible head', async () => {
        const overflow = new Error('too many tokens');
        const provider = new MockLanguageModelV4({
            doStream: {
                stream: providerStream([
                    { type: 'stream-start', warnings: [] },
                    { type: 'error', error: overflow }
                ])
            }
        });
        const agent = new ToolLoopAgent({ model: provider, maxRetries: 0 });
        const f = fixture(messages(1));
        const retry = vi.fn(async () =>
            (await reactiveCompactContext(f.params)).changed ? (await agent.stream({ prompt: 'smaller' })).stream : null
        );
        const result = await withReactiveCompaction(agent, retry).stream({ prompt: 'single attachment' });
        const parts = [];
        for await (const part of result.stream) parts.push(part);
        expect(parts).toContainEqual({ type: 'error', error: overflow });
        expect(provider.doStreamCalls).toHaveLength(1);
        expect(retry).toHaveBeenCalledOnce();
        expect(createModel).not.toHaveBeenCalled();
    });
});
