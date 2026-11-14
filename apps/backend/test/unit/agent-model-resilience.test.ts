import { APICallError, RetryError } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { withPreOutputRecovery, type ReactiveStreamPart } from '@/agent/compaction/reactive-stream';
import {
    createRetryHandler,
    describeModelError,
    isRetryableModelError,
    retryReasonOf,
    sleep
} from '@/agent/model/resilience';

function apiError(statusCode: number, isRetryable?: boolean) {
    return new APICallError({
        message: `status ${statusCode}`,
        url: 'https://model.invalid',
        requestBodyValues: {},
        statusCode,
        isRetryable
    });
}

function networkError(code: string) {
    return new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code }) });
}

function readable(parts: ReactiveStreamPart[], error?: unknown): ReadableStream<ReactiveStreamPart> {
    return new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            if (error) controller.error(error);
            else controller.close();
        }
    });
}

async function collect(source: ReadableStream<ReactiveStreamPart>) {
    const parts: ReactiveStreamPart[] = [];
    for await (const part of source) parts.push(part);
    return parts;
}

const answer = [{ type: 'text-delta' }, { type: 'finish' }];

function agentWith(streams: Array<() => ReadableStream<ReactiveStreamPart>>) {
    const stream = vi.fn(async (_options: Record<string, unknown>) => ({ stream: streams.shift()!() }));
    return { version: 'v', id: 'a', tools: {}, generate: vi.fn(), stream };
}

describe('isRetryableModelError', () => {
    it.each([
        [apiError(429), true],
        [apiError(503), true],
        [apiError(408), true],
        [apiError(400), false],
        [apiError(401), false],
        [apiError(500, false), false],
        [{ type: 'overloaded_error', message: 'Overloaded' }, true],
        [{ type: 'rate_limit_error' }, true],
        [{ statusCode: 529 }, true],
        [{ statusCode: 404 }, false],
        [new DOMException('模型响应超时', 'TimeoutError'), true],
        [networkError('ECONNRESET'), true],
        [networkError('EACCES'), false],
        [new Error('random'), false],
        [new DOMException('stopped', 'AbortError'), false],
        [new Error('context_length_exceeded'), false],
        [new RetryError({ message: 'exhausted', reason: 'maxRetriesExceeded', errors: [apiError(429)] }), false],
        [undefined, false],
        [null, false],
        ['text error', false]
    ])('%#: %s → %s', (error, expected) => {
        expect(isRetryableModelError(error)).toBe(expected);
    });
});

describe('describeModelError', () => {
    it('classifies auth, not-found and unavailable errors, unwrapping RetryError', () => {
        expect(describeModelError(apiError(401))).toContain('密钥无效');
        expect(describeModelError({ type: 'permission_error' })).toContain('密钥无效');
        expect(describeModelError(apiError(404))).toContain('模型不存在');
        expect(describeModelError(apiError(503))).toContain('暂不可用');
        expect(
            describeModelError(new RetryError({ message: 'x', reason: 'maxRetriesExceeded', errors: [apiError(429)] }))
        ).toContain('暂不可用');
        expect(
            describeModelError(new RetryError({ message: 'x', reason: 'errorNotRetryable', errors: [apiError(401)] }))
        ).toContain('密钥无效');
        expect(describeModelError(new DOMException('t', 'TimeoutError'))).toContain('暂不可用');
    });

    it('leaves unknown, aborted and overflow errors to the caller', () => {
        for (const error of [
            new Error('boom'),
            apiError(400),
            new DOMException('s', 'AbortError'),
            new Error('prompt is too long'),
            null
        ]) {
            expect(describeModelError(error)).toBeUndefined();
        }
    });

    it('summarises reasons without response bodies', () => {
        expect(retryReasonOf(apiError(429))).toBe('429 AI_APICallError');
        expect(retryReasonOf({ type: 'overloaded_error', code: 'x' })).toBe('overloaded_error x');
        expect(retryReasonOf('plain')).toBe('unknown');
    });
});

describe('sleep', () => {
    it('resolves after the delay and rejects immediately or later on abort', async () => {
        await expect(sleep(0)).resolves.toBeUndefined();
        const pre = new AbortController();
        pre.abort(new Error('pre'));
        await expect(sleep(1000, pre.signal)).rejects.toThrow('pre');
        const later = new AbortController();
        const pending = sleep(10_000, later.signal);
        later.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        const reasonless = new AbortController();
        Object.defineProperty(reasonless.signal, 'reason', { value: undefined });
        reasonless.abort();
        await expect(sleep(1, reasonless.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('retry handler in the pre-output recovery chain', () => {
    it('retries a retryable error part before output, reporting attempts and recovery', async () => {
        const onRetry = vi.fn();
        const onRecovered = vi.fn();
        const agent = agentWith([
            () => readable([{ type: 'start' }, { type: 'error', error: apiError(429) }]),
            () => readable([{ type: 'start' }, { type: 'error', error: { type: 'overloaded_error' } }]),
            () => readable(answer)
        ]);
        const wrapped = withPreOutputRecovery(agent, [createRetryHandler({ delaysMs: [0, 0], onRetry, onRecovered })]);
        const options = { prompt: 'p' };
        expect(await collect((await wrapped.stream(options)).stream)).toEqual(answer);
        expect(agent.stream).toHaveBeenCalledTimes(3);
        expect(agent.stream).toHaveBeenLastCalledWith(options);
        expect(onRetry.mock.calls.map((c) => c[0].attempt)).toEqual([1, 2]);
        expect(onRetry.mock.calls[0][0]).toMatchObject({ max: 2, delayMs: 0, reason: '429 AI_APICallError' });
        expect(onRecovered).toHaveBeenCalledTimes(2);
    });

    it('surfaces the last error once attempts are exhausted, and never retries after definitive output', async () => {
        const exhausted = withPreOutputRecovery(
            agentWith([
                () => readable([{ type: 'error', error: apiError(503) }]),
                () => readable([{ type: 'error', error: apiError(502) }])
            ]),
            [createRetryHandler({ delaysMs: [0] })]
        );
        const parts = await collect((await exhausted.stream({})).stream);
        expect(parts).toEqual([{ type: 'error', error: expect.objectContaining({ statusCode: 502 }) }]);

        const after = agentWith([() => readable([{ type: 'text-delta' }, { type: 'error', error: apiError(503) }])]);
        const late = withPreOutputRecovery(after, [createRetryHandler({ delaysMs: [0] })]);
        expect(await collect((await late.stream({})).stream)).toHaveLength(2);
        expect(after.stream).toHaveBeenCalledOnce();
    });

    it('retries errors thrown by stream() itself and by restream, and stops on abort during backoff', async () => {
        let calls = 0;
        const agent = {
            version: 'v',
            id: 'a',
            tools: {},
            generate: vi.fn(),
            stream: vi.fn(async (_options: Record<string, unknown>) => {
                calls++;
                if (calls <= 2) throw apiError(429);
                return { stream: readable(answer) };
            })
        };
        const wrapped = withPreOutputRecovery(agent, [createRetryHandler({ delaysMs: [0, 0] })]);
        expect(await collect((await wrapped.stream({})).stream)).toEqual(answer);

        const always = {
            ...agent,
            stream: vi.fn(async (_options: Record<string, unknown>) => Promise.reject(apiError(500)))
        };
        await expect(
            withPreOutputRecovery(always, [createRetryHandler({ delaysMs: [0] })]).stream({})
        ).rejects.toMatchObject({
            statusCode: 500
        });

        const controller = new AbortController();
        controller.abort(new DOMException('stopped', 'AbortError'));
        const aborted = withPreOutputRecovery(agentWith([() => readable([{ type: 'error', error: apiError(429) }])]), [
            createRetryHandler({ delaysMs: [5000] })
        ]);
        await expect(collect((await aborted.stream({ abortSignal: controller.signal })).stream)).rejects.toMatchObject({
            name: 'AbortError'
        });
    });

    it('uses the default backoff schedule when none is given', () => {
        expect(createRetryHandler().maxAttempts).toBe(2);
    });
});
