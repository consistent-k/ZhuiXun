import type { LanguageModelUsage, TextStreamPart, ToolSet, UIMessage, UIMessageChunk } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedModel } from '@/config/types';
import { desktopApprovalGrants } from '@/modules/chat/approval-grants';
import { runChatTurn, ChatTurnError, turnPhaseOf } from '@/modules/chat/service';
import { TurnMachine } from '@/modules/chat/turn-machine';
import type { SkillRegistry } from '@/modules/skills';

const f = vi.hoisted(() => ({
    activeModel: vi.fn(),
    modelByRef: vi.fn(),
    get: vi.fn(),
    append: vi.fn(),
    title: vi.fn(),
    updateTitle: vi.fn(),
    project: vi.fn(),
    roots: vi.fn(),
    normalize: vi.fn(),
    compact: vi.fn(),
    reactive: vi.fn(),
    routed: vi.fn(),
    progressive: vi.fn(),
    maintenance: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    hooks: { stop: vi.fn(async () => {}), matches: () => false, pre: vi.fn(), post: vi.fn() },
    createHooks: vi.fn(),
    guard: { state: { steps: 0 } as { steps: number; stopReason?: string }, stopWhen: [], prepareStep: () => undefined }
}));
vi.mock('@/config/model', () => ({ activeModel: f.activeModel, modelByRef: f.modelByRef }));
vi.mock('@/modules/conversations', () => ({
    getConversationStore: () => ({ get: f.get, appendMessages: f.append, updateTitle: f.updateTitle }),
    isValidConversationId: (id: string) => /^[a-z\d]+(?:-[a-z\d]+)*$/.test(id),
    generateConversationTitle: f.title
}));
vi.mock('@/modules/projects', () => ({ getProjectStore: () => ({ get: f.project }), resolveEffectiveRoots: f.roots }));
vi.mock('@/modules/chat/attachments/normalize', () => ({ normalizeAttachments: f.normalize }));
vi.mock('@/modules/chat/agents/runner', () => ({
    createRoutedAgent: f.routed,
    createProgressiveAgent: f.progressive,
    createTurnLoopGuard: () => f.guard
}));
vi.mock('@/modules/memory', () => ({ runMemoryMaintenance: f.maintenance }));
vi.mock('@/modules/hooks', () => ({ createHookRunner: f.createHooks }));
vi.mock('@/platform/logging/index', () => ({
    createLogger: () => ({ warn: f.warn, error: f.error, info: vi.fn(), debug: vi.fn() })
}));
vi.mock('@/agent/compaction', async () => ({
    withPreOutputRecovery: (await import('@/agent/compaction/reactive-stream')).withPreOutputRecovery,
    createOverflowHandler: (await import('@/agent/compaction/reactive-stream')).createOverflowHandler,
    maybeCompactContext: f.compact,
    reactiveCompactContext: f.reactive
}));

const model: ResolvedModel = {
    apiKey: 'test-only',
    baseURL: 'https://example.test',
    modelName: 'fake',
    kind: 'openai'
};
const registry = { getMCPAdapter: () => 'adapter', getMCPDiscovery: () => 'discovery' } as unknown as SkillRegistry;
const user = (id = 'user', text = '问题'): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const marker = { summarizedCount: 4, keptCount: 2, tokensBefore: 500, tokensAfter: 100 };

function usage(input?: number, output?: number, total?: number): LanguageModelUsage {
    return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        inputTokenDetails: { cacheReadTokens: 3 }
    } as LanguageModelUsage;
}
function part(value: { type: string; [key: string]: unknown }): TextStreamPart<ToolSet> {
    return value as TextStreamPart<ToolSet>;
}
function responseParts(lastUsage = usage(20, 4), text = '回答'): TextStreamPart<ToolSet>[] {
    return [
        part({ type: 'start' }),
        part({ type: 'start-step' }),
        part({ type: 'text-start', id: 'text' }),
        part({ type: 'text-delta', id: 'text', text }),
        part({ type: 'text-end', id: 'text' }),
        part({ type: 'finish-step', usage: lastUsage }),
        part({ type: 'finish', finishReason: 'stop', totalUsage: usage(1000, 200, 1200) })
    ];
}
function streamOf(parts: TextStreamPart<ToolSet>[]) {
    return new ReadableStream<TextStreamPart<ToolSet>>({
        start(c) {
            parts.forEach((p) => c.enqueue(p));
            c.close();
        }
    });
}
let agent: {
    version: string;
    id: string;
    tools: ToolSet;
    generate: ReturnType<typeof vi.fn>;
    stream: ReturnType<typeof vi.fn>;
};
async function consume(input: Parameters<typeof runChatTurn>[0], signal?: AbortSignal) {
    const handle = await runChatTurn(input, registry, signal);
    const chunks: UIMessageChunk[] = [];
    for await (const chunk of handle.stream) chunks.push(chunk);
    return { ...handle, chunks };
}
function finishMetadata(chunks: UIMessageChunk[]) {
    const finish = chunks.find((c) => c.type === 'finish');
    return finish?.type === 'finish' ? finish.messageMetadata : undefined;
}

beforeEach(() => {
    vi.resetAllMocks();
    f.guard.state = { steps: 0 };
    f.hooks.stop.mockResolvedValue(undefined);
    f.createHooks.mockReturnValue(f.hooks);
    f.activeModel.mockReturnValue(model);
    f.modelByRef.mockReturnValue(model);
    f.get.mockResolvedValue(null);
    f.project.mockResolvedValue(null);
    f.roots.mockResolvedValue({ additionalDirs: [], warnings: [] });
    f.append.mockResolvedValue(undefined);
    f.updateTitle.mockResolvedValue(undefined);
    f.title.mockResolvedValue('主题标题');
    f.maintenance.mockResolvedValue(undefined);
    f.normalize.mockImplementation(async (messages) => messages);
    f.compact.mockImplementation(async ({ messages }) => ({ modelInput: messages }));
    agent = {
        version: 'agent-v1',
        id: 'fake',
        tools: {},
        generate: vi.fn(),
        stream: vi.fn().mockImplementation(async () => ({ stream: streamOf(responseParts()) }))
    };
    f.routed.mockResolvedValue(agent);
    f.progressive.mockResolvedValue(agent);
});
afterEach(() => vi.restoreAllMocks());

describe('runChatTurn real UI stream orchestration', () => {
    it('rejects unavailable registry, missing keys and invalid explicit model before side effects', async () => {
        await expect(runChatTurn({ messages: [] }, undefined)).rejects.toMatchObject({
            status: 503,
            name: 'ChatTurnError'
        });
        f.activeModel.mockReturnValue(null);
        await expect(runChatTurn({ messages: [] }, registry)).rejects.toMatchObject({ status: 400 });
        f.modelByRef.mockReturnValue({ ...model, apiKey: '' });
        await expect(runChatTurn({ messages: [], model: 'no/model' }, registry)).rejects.toThrow('模型引用无效');
        expect(f.modelByRef).toHaveBeenCalledWith('no/model');
        expect(f.normalize).not.toHaveBeenCalled();
        expect(new ChatTurnError(409, 'conflict').status).toBe(409);
        expect(turnPhaseOf(new TurnMachine())).toBe('preparing');
    });

    it('persists full original history despite attachment normalization and compacted input; uses final-step usage/title/marker', async () => {
        const original: UIMessage[] = [
            user('old', '旧问题'),
            {
                id: 'image',
                role: 'user',
                parts: [{ type: 'file', url: 'http://local/image', mediaType: 'image/png', filename: 'x.png' }]
            },
            user()
        ];
        const compacted = [user('user', '摘要')];
        f.normalize.mockResolvedValue(
            original.map((m) =>
                m.id === 'image'
                    ? { ...m, parts: [{ type: 'file', url: 'data:image/png;base64,YQ==', mediaType: 'image/png' }] }
                    : m
            )
        );
        f.compact.mockImplementation(async ({ onCompacting }) => {
            onCompacting();
            return { modelInput: compacted, marker };
        });
        // 两个 step 的 usage 不能相加，否则后续压缩判阈会重复计算上下文。
        const parts = responseParts();
        parts.splice(2, 0, part({ type: 'finish-step', usage: usage(90, 10, 100) }), part({ type: 'start-step' }));
        agent.stream.mockImplementation(async () => {
            await Promise.resolve();
            return { stream: streamOf(parts) };
        });
        const result = await consume({ messages: original, sessionId: 'session' });
        expect(result.canResume).toBe(true);
        expect(result.chatId).toBe('session');
        expect(agent.stream.mock.calls[0][0].prompt).toEqual([
            { role: 'user', content: [{ type: 'text', text: '摘要' }] }
        ]);
        expect(finishMetadata(result.chunks)).toEqual({
            usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, cachedInputTokens: 3 },
            title: '主题标题',
            compaction: marker
        });
        expect(result.chunks.filter((c) => c.type === 'data-compaction')).toHaveLength(2);
        expect(f.append).toHaveBeenCalledTimes(2);
        const final = f.append.mock.calls[1][1];
        expect(final.map((m: { id: string }) => m.id).slice(0, 3)).toEqual(['old', 'image', 'user']);
        expect(final[1]).toMatchObject({ content: '[图片] x.png', parts: original[1].parts });
        expect(final.at(-1)).toMatchObject({
            role: 'assistant',
            content: '回答',
            metadata: finishMetadata(result.chunks)
        });
        expect(f.updateTitle).toHaveBeenCalledWith('session', '主题标题', { auto: true });
        expect(f.maintenance).toHaveBeenCalledWith({
            transcript: [
                { role: 'user', content: '旧问题' },
                { role: 'user', content: '问题' },
                { role: 'assistant', content: '回答' }
            ],
            sessionId: 'session',
            projectId: undefined
        });
        expect(f.createHooks).toHaveBeenCalledWith({ sessionId: 'session', projectId: undefined, cwd: undefined });
        expect(f.hooks.stop).toHaveBeenCalledWith({ stopReason: undefined, lastAssistantText: '回答' });
    });

    it('uses frozen session roots, propagates project trust/preset and latest user text/id', async () => {
        const frozen = [{ path: '/frozen', primary: true }];
        f.get.mockResolvedValue({ roots: frozen, titleAuto: true });
        f.project.mockResolvedValue({ roots: [{ path: '/new' }], trusted: true, skillPreset: ['a'] });
        f.roots.mockResolvedValue({ primaryDir: '/frozen', additionalDirs: ['/more'], warnings: ['warning'] });
        await consume({
            messages: [
                user('question', '  最新问题  '),
                { id: 'blank', role: 'user', parts: [] },
                { id: 'a', role: 'assistant', parts: [] }
            ],
            sessionId: 'session',
            projectId: 'project'
        });
        expect(f.roots).toHaveBeenCalledWith(frozen);
        expect(f.routed).toHaveBeenCalledWith(
            registry,
            model,
            'adapter',
            'session',
            'project',
            ['a'],
            { primaryDir: '/frozen', additionalDirs: ['/more'], warnings: ['warning'], trusted: true },
            '最新问题',
            'blank',
            undefined,
            { loopGuard: f.guard, hooks: f.hooks }
        );
        expect(f.title).not.toHaveBeenCalled();
    });

    it('expands slash commands for the model and recall but persists the original text with data-command', async () => {
        const command: UIMessage = {
            id: 'cmd',
            role: 'user',
            parts: [
                { type: 'text', text: '/review a.ts' },
                { type: 'data-command', data: { name: 'review', args: 'a.ts', expanded: '请审查 a.ts' } }
            ] as UIMessage['parts']
        };
        await consume({ messages: [command], sessionId: 'session' });
        expect(f.normalize.mock.calls[0][0][0].parts).toEqual([{ type: 'text', text: '请审查 a.ts' }]);
        expect(f.routed.mock.calls[0][7]).toBe('请审查 a.ts');
        const persisted = f.append.mock.calls[0][1][0];
        expect(persisted.parts).toEqual(command.parts);
    });

    it('passes progressive history, project roots and explicit model reference', async () => {
        const messages = [user()];
        const roots = [{ path: '/project', primary: true }];
        f.project.mockResolvedValue({ roots });
        await consume({
            messages,
            sessionId: 'session',
            projectId: 'project',
            agentMode: 'progressive',
            model: 'test/fake'
        });
        expect(f.modelByRef).toHaveBeenCalledWith('test/fake');
        expect(f.roots).toHaveBeenCalledWith(roots);
        expect(f.progressive).toHaveBeenCalledWith(
            registry,
            model,
            'adapter',
            'discovery',
            'session',
            'project',
            expect.any(Object),
            messages,
            '问题',
            'user',
            undefined,
            { loopGuard: f.guard, hooks: f.hooks }
        );
        expect(f.routed).not.toHaveBeenCalled();
    });

    it('prefers request persona over conversation persona and persists the override', async () => {
        f.get.mockResolvedValue({ personaId: 'evidence' });
        await consume({ messages: [user()], sessionId: 'session', personaId: 'teaching' });
        expect(f.routed).toHaveBeenCalledWith(
            registry,
            model,
            'adapter',
            'session',
            undefined,
            undefined,
            expect.any(Object),
            '问题',
            'user',
            'teaching',
            { loopGuard: f.guard, hooks: f.hooks }
        );
        expect(f.append).toHaveBeenCalledWith(
            'session',
            expect.any(Array),
            expect.objectContaining({ personaId: 'teaching' })
        );
    });

    it('uses the conversation persona when the request does not override it', async () => {
        f.get.mockResolvedValue({ personaId: 'concise' });
        await consume({ messages: [user()], sessionId: 'session' });
        expect(f.routed).toHaveBeenCalledWith(
            registry,
            model,
            'adapter',
            'session',
            undefined,
            undefined,
            expect.any(Object),
            '问题',
            'user',
            'concise',
            { loopGuard: f.guard, hooks: f.hooks }
        );
    });

    it.each([undefined, '../invalid'])('does not persist/title/compact without resumable id %s', async (sessionId) => {
        const result = await consume({ messages: [user()], sessionId });
        expect(result.canResume).toBe(false);
        expect(result.chatId).not.toBe(sessionId);
        expect(result.chunks.some((c) => c.type === 'text-delta')).toBe(true);
        expect(f.append).not.toHaveBeenCalled();
        expect(f.title).not.toHaveBeenCalled();
        expect(f.compact).not.toHaveBeenCalled();
        expect(f.maintenance).not.toHaveBeenCalled();
    });

    it.each([{ titleAuto: true }, { messages: [{ role: 'assistant' }] }])(
        'does not rename a previously answered or auto-titled conversation %j',
        async (existing) => {
            f.get.mockResolvedValue(existing);
            await consume({ messages: [user()], sessionId: 'session' });
            expect(f.title).not.toHaveBeenCalled();
        }
    );

    it.each([null, 'generated'])('title generation failure is best effort (%s)', async (title) => {
        f.title.mockResolvedValue(title);
        f.updateTitle.mockRejectedValue(new Error('title save failed'));
        await consume({ messages: [user()], sessionId: 'session' });
        expect(f.append).toHaveBeenCalledTimes(2);
        if (title) expect(f.warn).toHaveBeenCalledWith('首轮标题生成失败（忽略）', expect.anything());
    });

    it('falls back when compaction, title lookup and persistence fail', async () => {
        f.compact.mockRejectedValue(new Error('cannot compact'));
        f.get.mockResolvedValueOnce(null).mockRejectedValue(new Error('read failed'));
        f.append.mockRejectedValue(new Error('write failed'));
        const result = await consume({ messages: [user()], sessionId: 'session' });
        expect(result.chunks.some((c) => c.type === 'text-delta')).toBe(true);
        expect(f.warn).toHaveBeenCalledWith('上下文压缩失败（忽略，使用全量历史）', expect.anything());
        expect(f.warn).toHaveBeenCalledWith('服务端落库失败（忽略，前端仍会落库）', expect.anything());
    });

    it('keeps tool-only/file-only messages but drops empty messages and builds bounded text transcript', async () => {
        const messages: UIMessage[] = Array.from({ length: 14 }, (_, i) => user(`u${i}`, `text ${i}`));
        messages.push(
            { id: 'empty', role: 'assistant', parts: [] },
            {
                id: 'tool',
                role: 'assistant',
                parts: [{ type: 'tool-search', toolCallId: 'call', state: 'output-available', input: {}, output: 'ok' }]
            },
            {
                id: 'file',
                role: 'user',
                parts: [{ type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,YQ==' }]
            }
        );
        // agent input 使用可被 SDK 校验的文本；被测 service 的落库仍必须保留引用附件/工具。
        f.normalize.mockResolvedValue([user()]);
        await consume({ messages, sessionId: 'session' });
        const stored = f.append.mock.calls[1][1];
        expect(stored.some((m: { id: string }) => m.id === 'empty')).toBe(false);
        expect(stored.find((m: { id: string }) => m.id === 'tool').content).toBe('');
        expect(stored.find((m: { id: string }) => m.id === 'file').content).toBe('[文件]');
        const transcript = f.maintenance.mock.calls[0][0].transcript;
        expect(transcript[0].content).toBe('text 7');
        expect(transcript).toHaveLength(9);
    });

    it('does not persist an empty turn or ask for a title without a user text/file', async () => {
        agent.stream.mockResolvedValue({
            stream: streamOf([
                part({ type: 'start' }),
                part({ type: 'finish', finishReason: 'stop', totalUsage: usage() })
            ])
        });
        const result = await consume({ messages: [], sessionId: 'session' });
        expect(f.append).not.toHaveBeenCalled();
        expect(f.title).not.toHaveBeenCalled();
        expect(result.chunks).toEqual([
            { type: 'error', errorText: expect.stringContaining('Messages array must not be empty') }
        ]);
    });

    it('uses finish total usage when no finish-step exists and respects provider totalTokens', async () => {
        agent.stream.mockResolvedValue({
            stream: streamOf(responseParts(usage(5, undefined, 42)).filter((p) => p.type !== 'finish-step'))
        });
        const result = await consume({ messages: [user()] });
        expect(finishMetadata(result.chunks)).toEqual({
            usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedInputTokens: 3 }
        });
        agent.stream.mockResolvedValue({ stream: streamOf(responseParts(usage(undefined, 8, 77))) });
        const second = await consume({ messages: [user()] });
        expect(finishMetadata(second.chunks)).toMatchObject({ usage: { totalTokens: 77 } });
    });

    it('reports preparation and agent construction failures using actual stream error callback', async () => {
        f.normalize.mockRejectedValueOnce(new Error('attachment unavailable'));
        await expect(runChatTurn({ messages: [user()] }, registry)).rejects.toThrow('attachment unavailable');
        f.routed.mockRejectedValue(new Error('agent unavailable'));
        const result = await consume({ messages: [user()], sessionId: 'session' });
        expect(result.chunks).toContainEqual({ type: 'error', errorText: 'Error: agent unavailable' });
        expect(f.error).toHaveBeenCalled();
    });

    it('persists partial assistant on stream error without illegal finalization', async () => {
        agent.stream.mockResolvedValue({
            stream: streamOf([...responseParts().slice(0, 5), part({ type: 'error', error: 'model failed' })])
        });
        const result = await consume({ messages: [user()], sessionId: 'session' });
        expect(result.chunks).toContainEqual({ type: 'error', errorText: 'model failed' });
        expect(f.error).toHaveBeenCalledWith('流式执行出错', { err: 'model failed' });
        expect(f.append.mock.calls.at(-1)![1].at(-1)).toMatchObject({ content: '回答' });
    });

    it('forwards abort signal to SDK and persists partial response on abort', async () => {
        const abort = new AbortController();
        agent.stream.mockImplementation(async ({ abortSignal }) => {
            expect(abortSignal).toBe(abort.signal);
            abort.abort();
            return { stream: streamOf([...responseParts().slice(0, 5), part({ type: 'abort', reason: 'cancelled' })]) };
        });
        const result = await consume({ messages: [user()], sessionId: 'session' }, abort.signal);
        expect(result.chunks).toContainEqual({ type: 'abort', reason: 'cancelled' });
        expect(f.append.mock.calls.at(-1)![1].at(-1)).toMatchObject({ content: '回答' });
    });

    it('observes background maintenance rejection without unhandled promise or losing answer', async () => {
        f.maintenance.mockRejectedValue(new Error('maintenance offline'));
        const result = await consume({ messages: [user()], sessionId: 'session' });
        expect(result.chunks.some((c) => c.type === 'finish')).toBe(true);
        expect(f.warn).toHaveBeenCalledWith('记忆维护失败（忽略）', expect.anything());
    });

    it('observes Stop hook rejection without affecting the answer', async () => {
        f.hooks.stop.mockRejectedValue(new Error('hook offline'));
        const result = await consume({ messages: [user()], sessionId: 'session' });
        expect(result.chunks.some((c) => c.type === 'finish')).toBe(true);
        await vi.waitFor(() =>
            expect(f.warn).toHaveBeenCalledWith(
                'Stop hooks 执行失败（忽略）',
                expect.objectContaining({ chatId: 'session' })
            )
        );
    });

    it.each(['changed', 'unchanged', 'throw', 'retry-throw'] as const)(
        'reactive compaction callback consumes real stream: %s',
        async (mode) => {
            const overflow = new Error('maximum context length exceeded');
            agent.stream.mockResolvedValueOnce({
                stream: streamOf([part({ type: 'start' }), part({ type: 'error', error: overflow })])
            });
            f.reactive.mockImplementation(async ({ onCompacting }) => {
                onCompacting();
                if (mode === 'throw') throw new Error('summary failed');
                return { changed: mode !== 'unchanged', modelInput: [user('retry', '短摘要')], marker };
            });
            if (mode === 'retry-throw') agent.stream.mockRejectedValueOnce(new Error('retry failed'));
            const result = await consume({ messages: [user()], sessionId: 'session' });
            expect(f.reactive).toHaveBeenCalledOnce();
            if (mode === 'changed') {
                expect(agent.stream).toHaveBeenCalledTimes(2);
                expect(agent.stream.mock.calls[1][0].prompt).toEqual([
                    { role: 'user', content: [{ type: 'text', text: '短摘要' }] }
                ]);
                expect(finishMetadata(result.chunks)).toMatchObject({ compaction: marker });
                expect(result.chunks.some((c) => c.type === 'text-delta')).toBe(true);
            } else {
                expect(result.chunks).toContainEqual({
                    type: 'error',
                    errorText: 'Error: maximum context length exceeded'
                });
            }
        }
    );

    it('retries a rate-limited stream before output and announces the retry with transient data parts', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        try {
            const limited = Object.assign(new Error('rate limited'), { statusCode: 429, isRetryable: true });
            agent.stream.mockResolvedValueOnce({
                stream: streamOf([part({ type: 'start' }), part({ type: 'error', error: limited })])
            });
            const pending = consume({ messages: [user()] });
            await vi.advanceTimersByTimeAsync(1000);
            const result = await pending;
            expect(agent.stream).toHaveBeenCalledTimes(2);
            expect(result.chunks).toContainEqual(
                expect.objectContaining({
                    type: 'data-retry',
                    data: expect.objectContaining({ phase: 'start', attempt: 1, max: 2, delayMs: 1000 })
                })
            );
            expect(result.chunks).toContainEqual(
                expect.objectContaining({ type: 'data-retry', data: { phase: 'done' } })
            );
            expect(result.chunks.some((c) => c.type === 'text-delta')).toBe(true);
            expect(finishMetadata(result.chunks)).not.toHaveProperty('stopReason');
        } finally {
            vi.useRealTimers();
        }
    });

    it('turns auth failures into a readable message and records stopReason=error', async () => {
        const auth = Object.assign(new Error('invalid x-api-key'), { statusCode: 401, isRetryable: false });
        agent.stream.mockResolvedValue({
            stream: streamOf([
                part({ type: 'start' }),
                part({ type: 'error', error: auth }),
                part({ type: 'finish', finishReason: 'error', totalUsage: usage(1, 1) })
            ])
        });
        const result = await consume({ messages: [user()] });
        expect(agent.stream).toHaveBeenCalledOnce();
        const error = result.chunks.find((c) => c.type === 'error');
        expect(error).toMatchObject({ errorText: expect.stringContaining('模型密钥无效或无权限') });
        expect(error).toMatchObject({ errorText: expect.stringContaining('invalid x-api-key') });
        expect(finishMetadata(result.chunks)).toMatchObject({ stopReason: 'error' });
    });

    it('writes the loop guard stop reason, step count and cache write tokens into finish metadata', async () => {
        f.guard.state = { steps: 40, stopReason: 'max-steps' };
        agent.stream.mockResolvedValue({
            stream: streamOf(
                responseParts({
                    ...usage(20, 4),
                    inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 9 }
                } as LanguageModelUsage)
            )
        });
        const result = await consume({ messages: [user()] });
        expect(finishMetadata(result.chunks)).toMatchObject({
            stopReason: 'max-steps',
            steps: 40,
            usage: { cachedInputTokens: 3, cacheWriteTokens: 9 }
        });
    });
});

describe('approval mode on chat turns', () => {
    it('requires a live grant scoped to the session for full access', async () => {
        const request = { messages: [user()], sessionId: 'session', approvalMode: 'full-access' as const };
        await expect(runChatTurn(request, registry)).rejects.toMatchObject({ status: 403 });
        const approvalGrant = desktopApprovalGrants.grant('session');
        try {
            await expect(
                runChatTurn({ ...request, sessionId: 'other', approvalGrant }, registry)
            ).rejects.toMatchObject({ status: 403 });
            await consume({ ...request, approvalGrant });
            expect(f.routed.mock.calls[0].at(-1)).toMatchObject({ approvalMode: 'full-access' });
            expect(f.append.mock.calls[0][2]).toMatchObject({ approvalTurn: { turnId: 'user', mode: 'full-access' } });
            expect(JSON.stringify(f.append.mock.calls)).not.toContain(approvalGrant);
        } finally {
            desktopApprovalGrants.revoke('session');
        }
        await expect(runChatTurn({ ...request, approvalGrant }, registry)).rejects.toMatchObject({ status: 403 });
    });

    it('uses the server tool input and frozen mode on continuation, rejecting replays', async () => {
        const pending = {
            type: 'tool-Bash',
            toolCallId: 'call',
            input: { command: 'printf original' },
            state: 'approval-requested',
            approval: { id: 'approval' }
        };
        const saved = { id: 'assistant', role: 'assistant', parts: [pending] };
        const approvalTurn = { turnId: 'user', mode: 'auto-review', pending: saved };
        f.get.mockResolvedValue({ messages: [user(), saved], approvalTurn });
        const submitted = {
            ...pending,
            type: 'tool-Write',
            input: { path: '/changed' },
            state: 'approval-responded',
            approval: { id: 'approval', approved: true }
        };
        const request = {
            messages: [user(), { id: saved.id, role: 'assistant', parts: [submitted] }] as UIMessage[],
            sessionId: 'session',
            approvalMode: 'full-access' as const
        };
        await consume(request);
        expect(f.normalize.mock.calls[0][0].at(-1).parts).toEqual([
            {
                ...pending,
                state: 'approval-responded',
                approval: { id: 'approval', approved: true }
            }
        ]);
        expect(f.routed.mock.calls[0].at(-1)).toMatchObject({ approvalMode: 'auto-review' });

        f.get.mockResolvedValue({ messages: [user(), saved], approvalTurn: { ...approvalTurn, pending: undefined } });
        await expect(runChatTurn(request, registry)).rejects.toMatchObject({ status: 409 });
    });
});
