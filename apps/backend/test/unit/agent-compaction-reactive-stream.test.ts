import { describe, expect, it, vi } from 'vitest';

import { withReactiveCompaction, type ReactiveStreamPart } from '@/agent/compaction/reactive-stream';

const overflow = new Error('context_length_exceeded');
const lifecycle = [{ type: 'start' }, { type: 'start-step' }, { type: 'raw' }];
const answer = [{ type: 'text-delta', text: 'recovered' }, { type: 'finish' }];

function readable(parts: ReactiveStreamPart[], error?: unknown): ReadableStream<ReactiveStreamPart> {
    return new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            if (error) controller.error(error);
            else controller.close();
        }
    });
}

async function* iterable(parts: ReactiveStreamPart[]) {
    yield* parts;
}

async function collect(source: ReadableStream<ReactiveStreamPart>) {
    const parts: ReactiveStreamPart[] = [];
    for await (const part of source) parts.push(part);
    return parts;
}

function agentWith(
    stream: (options: Record<string, unknown>) => Promise<{ stream: ReadableStream<ReactiveStreamPart> }>
) {
    return {
        version: 'agent-v1',
        id: 'fake',
        tools: {},
        generate: vi.fn(async () => 'generated'),
        stream: vi.fn(stream)
    };
}

describe('reactive compaction stream adapter', () => {
    it('preserves agent metadata, delegates this and options, and forwards healthy streams', async () => {
        const options = { prompt: 'hello' };
        const agent = agentWith(async function (this: unknown) {
            expect(this).toBe(agent);
            return { stream: readable([...lifecycle, ...answer]) };
        });
        agent.generate.mockImplementation(async function (this: unknown) {
            expect(this).toBe(agent);
            return 'generated';
        });
        const retry = vi.fn();
        const wrapped = withReactiveCompaction(agent, retry);
        expect(wrapped.version).toBe(agent.version);
        expect(wrapped.id).toBe(agent.id);
        expect(wrapped.tools).toBe(agent.tools);
        await expect(wrapped.generate()).resolves.toBe('generated');
        expect(agent.generate).toHaveBeenCalledOnce();
        expect(await collect((await wrapped.stream(options)).stream)).toEqual([...lifecycle, ...answer]);
        expect(agent.stream).toHaveBeenCalledWith(options);
        expect(retry).not.toHaveBeenCalled();
    });

    it.each([{ parts: [] }, { parts: lifecycle }])(
        'flushes buffered lifecycle events on an empty completion',
        async ({ parts }) => {
            const retry = vi.fn();
            const wrapped = withReactiveCompaction(
                agentWith(async () => ({ stream: readable(parts) })),
                retry
            );
            expect(await collect((await wrapped.stream({})).stream)).toEqual(parts);
            expect(retry).not.toHaveBeenCalled();
        }
    );

    it('retries an overflow thrown before stream creation and keeps the same options', async () => {
        const options = { messages: ['original'] };
        const retry = vi.fn(async () => iterable(answer));
        const wrapped = withReactiveCompaction(
            agentWith(async () => {
                throw overflow;
            }),
            retry
        );
        expect(await collect((await wrapped.stream(options)).stream)).toEqual(answer);
        expect(retry).toHaveBeenCalledExactlyOnceWith(options);
    });

    it('rethrows immediate non-overflow errors, or the original overflow when no smaller prompt exists', async () => {
        const unrelated = new Error('unauthorized');
        const retry = vi.fn(async () => null);
        for (const error of [unrelated, overflow]) {
            const wrapped = withReactiveCompaction(
                agentWith(async () => {
                    throw error;
                }),
                retry
            );
            await expect(wrapped.stream({})).rejects.toBe(error);
        }
        expect(retry).toHaveBeenCalledOnce();
    });

    it('retries overflow during lazy consumption and does not retry unrelated stream exceptions', async () => {
        const retry = vi.fn(async () => iterable(answer));
        const wrapped = withReactiveCompaction(
            agentWith(async () => ({ stream: readable([], overflow) })),
            retry
        );
        expect(await collect((await wrapped.stream({})).stream)).toEqual(answer);
        expect(retry).toHaveBeenCalledOnce();
        const unrelated = new Error('network disconnected');
        const failed = withReactiveCompaction(
            agentWith(async () => ({ stream: readable([], unrelated) })),
            retry
        );
        await expect(collect((await failed.stream({})).stream)).rejects.toBe(unrelated);
        expect(retry).toHaveBeenCalledOnce();
        const unchanged = withReactiveCompaction(
            agentWith(async () => ({ stream: readable([], overflow) })),
            async () => null
        );
        await expect(collect((await unchanged.stream({})).stream)).rejects.toBe(overflow);
    });

    it('discards buffered preamble, closes the rejected source, and forwards retry errors without a second attempt', async () => {
        const closed = vi.fn(async () => {
            throw new Error('close failed');
        });
        const source = {
            [Symbol.asyncIterator]() {
                const parts = [...lifecycle, { type: 'error', error: overflow }];
                return {
                    next: async () =>
                        parts.length
                            ? { done: false as const, value: parts.shift()! }
                            : { done: true as const, value: undefined },
                    return: closed
                };
            }
        };
        const retryParts = [...answer, { type: 'error', error: overflow }];
        const retry = vi.fn(async () => iterable(retryParts));
        const agent = agentWith(async () => ({ stream: source as unknown as ReadableStream<ReactiveStreamPart> }));
        expect(await collect((await withReactiveCompaction(agent, retry).stream({})).stream)).toEqual(retryParts);
        expect(retry).toHaveBeenCalledOnce();
        expect(closed).toHaveBeenCalledOnce();
    });

    it('preserves original lifecycle, error and remaining parts when retry cannot shrink history', async () => {
        const parts = [...lifecycle, { type: 'error', error: overflow }, { type: 'finish' }];
        const retry = vi.fn(async () => null);
        const wrapped = withReactiveCompaction(
            agentWith(async () => ({ stream: readable(parts) })),
            retry
        );
        expect(await collect((await wrapped.stream({})).stream)).toEqual(parts);
        expect(retry).toHaveBeenCalledOnce();
    });

    it.each(['text-start', 'text-delta', 'reasoning-start', 'tool-call', 'finish', 'error'])(
        'never retries after definitive %s',
        async (type) => {
            const first = { type, ...(type === 'error' ? { error: new Error('rate limit') } : {}) };
            const parts = [...lifecycle, first, { type: 'error', error: overflow }, { type: 'finish' }];
            const retry = vi.fn();
            const wrapped = withReactiveCompaction(
                agentWith(async () => ({ stream: readable(parts) })),
                retry
            );
            expect(await collect((await wrapped.stream({})).stream)).toEqual(parts);
            expect(retry).not.toHaveBeenCalled();
        }
    );

    it('forwards errors thrown by retry and by the source after definitive output', async () => {
        const retryError = new Error('failed to rebuild prompt');
        const retry = vi.fn(async () => {
            throw retryError;
        });
        const wrapped = withReactiveCompaction(
            agentWith(async () => ({ stream: readable([{ type: 'error', error: overflow }]) })),
            retry
        );
        await expect(collect((await wrapped.stream({})).stream)).rejects.toBe(retryError);
        async function* source() {
            yield { type: 'text-start' };
            throw overflow;
        }
        const failed = withReactiveCompaction(
            agentWith(async () => ({ stream: source() as unknown as ReadableStream<ReactiveStreamPart> })),
            retry
        );
        await expect(collect((await failed.stream({})).stream)).rejects.toBe(overflow);
        expect(retry).toHaveBeenCalledOnce();
    });

    it('supports iterators without return() and propagates cancellation to a retry iterator', async () => {
        const source = {
            [Symbol.asyncIterator]() {
                return { next: async () => ({ done: false as const, value: { type: 'error', error: overflow } }) };
            }
        };
        const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
        const retry = async () => ({
            [Symbol.asyncIterator]() {
                return {
                    next: async () => ({ done: false as const, value: { type: 'text-delta' } }),
                    return: returned
                };
            }
        });
        const wrapped = withReactiveCompaction(
            agentWith(async () => ({ stream: source as unknown as ReadableStream<ReactiveStreamPart> })),
            retry
        );
        const reader = (await wrapped.stream({})).stream.getReader();
        expect((await reader.read()).value).toEqual({ type: 'text-delta' });
        await reader.cancel();
        expect(returned).toHaveBeenCalledOnce();
    });

    it('allows cancelling an immediately retried iterable which has no return()', async () => {
        const retry = async () => ({
            [Symbol.asyncIterator]() {
                return { next: async () => ({ done: false as const, value: { type: 'text-delta' } }) };
            }
        });
        const wrapped = withReactiveCompaction(
            agentWith(async () => {
                throw overflow;
            }),
            retry
        );
        const reader = (await wrapped.stream({})).stream.getReader();
        await reader.read();
        await expect(reader.cancel()).resolves.toBeUndefined();
    });
});
