import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModel } from '@/agent/model/provider';
import { RESPONSE_TIMEOUT_MS } from '@/config/model';
import type { ResolvedModel } from '@/config/types';

const prompt: LanguageModelV4CallOptions['prompt'] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
const configured = (kind: ResolvedModel['kind']): ResolvedModel => ({
    kind,
    baseURL: 'https://model.example.invalid/v1',
    apiKey: 'test-only-fake-key',
    modelName: 'test-model'
});
const modelFor = (kind: ResolvedModel['kind']) => createModel(configured(kind)) as LanguageModelV4;
const compatibleBody = (content = 'answer') => ({
    id: 'response-1',
    model: 'test-model',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('agent model provider SDK boundaries', () => {
    it.each([
        {
            kind: 'openai' as const,
            endpoint: '/responses',
            response: {
                id: 'response-1',
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        id: 'message-1',
                        content: [{ type: 'output_text', text: 'answer', annotations: [] }]
                    }
                ],
                usage: { input_tokens: 3, output_tokens: 2 }
            },
            authHeader: 'authorization',
            authValue: 'Bearer test-only-fake-key'
        },
        {
            kind: 'anthropic' as const,
            endpoint: '/messages',
            response: {
                id: 'response-1',
                type: 'message',
                role: 'assistant',
                model: 'test-model',
                content: [{ type: 'text', text: 'answer' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 3, output_tokens: 2 }
            },
            authHeader: 'x-api-key',
            authValue: 'test-only-fake-key'
        },
        {
            kind: 'google' as const,
            endpoint: '/models/test-model:generateContent',
            response: {
                candidates: [
                    {
                        content: { role: 'model', parts: [{ text: 'answer' }] },
                        finishReason: 'STOP',
                        index: 0
                    }
                ],
                usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
            },
            authHeader: 'x-goog-api-key',
            authValue: 'test-only-fake-key'
        },
        {
            kind: 'openai-compatible' as const,
            endpoint: '/chat/completions',
            response: compatibleBody(),
            authHeader: 'authorization',
            authValue: 'Bearer test-only-fake-key'
        }
    ])('constructs $kind with the configured URL/key/model and executes its actual SDK', async (example) => {
        const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(example.response));
        vi.stubGlobal('fetch', fakeFetch);
        const model = modelFor(example.kind);
        expect(model.modelId).toBe('test-model');
        const response = await model.doGenerate({ prompt });
        expect(response.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'answer' }));
        expect(fakeFetch).toHaveBeenCalledTimes(1);
        const [url, init] = fakeFetch.mock.calls[0];
        expect(url).toBe(`https://model.example.invalid/v1${example.endpoint}`);
        expect(new Headers(init?.headers).get(example.authHeader)).toBe(example.authValue);
        // Google 用 contents 承载对话，OpenAI/兼容端点用 messages，Responses 用 input
        const body = JSON.parse(init?.body as string);
        // Google 把模型名放在 URL 路径（/models/<id>:generateContent），其余端点放在 body
        if (body.model !== undefined) expect(body.model).toBe('test-model');
        expect(body.messages ?? body.input ?? body.contents).toEqual(
            expect.arrayContaining([expect.objectContaining({ role: 'user' })])
        );
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('extracts compatible-provider think tags using actual reasoning middleware', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(Response.json(compatibleBody('<think>reason</think>answer')))
        );
        const result = await modelFor('openai-compatible').doGenerate({ prompt });
        expect(result.content).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ type: 'reasoning', text: 'reason' }),
                expect.objectContaining({ type: 'text', text: 'answer' })
            ])
        );
        expect(
            result.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
        ).not.toContain('<think>');
    });

    it('rejects unsupported provider kinds rather than silently selecting an SDK', () => {
        expect(() => createModel({ ...configured('openai'), kind: 'unsupported' } as unknown as ResolvedModel)).toThrow(
            'Unsupported provider kind: unsupported'
        );
    });

    it('aborts only the pre-response-header phase and cleans up its timeout on failure', async () => {
        vi.useFakeTimers();
        let observed: AbortSignal | null | undefined;
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>((_input, init) => {
                observed = init?.signal;
                return new Promise((_resolve, reject) =>
                    observed!.addEventListener('abort', () => reject(observed!.reason))
                );
            })
        );
        const pending = modelFor('openai').doGenerate({ prompt });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
        await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS - 1);
        expect(observed?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(observed?.reason.message).toContain('模型响应超时');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('merges caller cancellation and cleans timeout when fetch fails before headers', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let observed: AbortSignal | null | undefined;
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>((_input, init) => {
                observed = init?.signal;
                return new Promise((_resolve, reject) =>
                    observed!.addEventListener('abort', () => reject(observed!.reason))
                );
            })
        );
        const reason = new DOMException('user stopped', 'AbortError');
        const pending = modelFor('openai').doGenerate({ prompt, abortSignal: controller.signal });
        const rejected = expect(pending).rejects.toBe(reason);
        await vi.advanceTimersByTimeAsync(0);
        expect(observed).not.toBe(controller.signal);
        controller.abort(reason);
        await rejected;
        expect(observed?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the response timeout as soon as headers arrive, even if a stream body is still pending', async () => {
        vi.useFakeTimers();
        let upstreamSignal: AbortSignal | null | undefined;
        let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                bodyController = controller;
            }
        });
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (_input, init) => {
                upstreamSignal = init?.signal;
                return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
            })
        );
        const controller = new AbortController();
        const result = await modelFor('openai-compatible').doStream({ prompt, abortSignal: controller.signal });
        await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS * 2);
        expect(upstreamSignal?.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        controller.abort('user stopped after headers');
        expect(upstreamSignal?.aborted).toBe(true);
        expect(upstreamSignal?.reason).toBe('user stopped after headers');
        bodyController!.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        bodyController!.close();
        const chunks = [];
        for await (const chunk of result.stream) chunks.push(chunk);
        expect(chunks.some((chunk) => chunk.type === 'stream-start')).toBe(true);
    });

    it('cleans the timeout when an immediate transport rejection is propagated', async () => {
        vi.useFakeTimers();
        const failure = new Error('offline fake');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(failure));
        await expect(modelFor('openai-compatible').doGenerate({ prompt })).rejects.toBe(failure);
        expect(vi.getTimerCount()).toBe(0);
    });
});
