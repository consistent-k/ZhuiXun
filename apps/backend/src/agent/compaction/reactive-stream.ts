/**
 * 首输出前错误恢复的流式接线：provider 在**首个模型输出之前**报错时，交给有序处理器链恢复
 * （超窗 → 压缩后重试；限流/过载/断连 → 退避后重试），恢复出的新流继续按同一规则探测。
 *
 * 为什么不能简单 try/catch `agent.stream()`：AI SDK 的 `stream()` 返回懒执行结果，真正的模型请求
 * 发生在消费 `result.stream` 时，错误可能以「抛异常」或「error part」两种形态出现，且往往在
 * `start` / `start-step` 之后。因此这里先探测到第一个“确定性”part：
 * - 在此之前遇到错误 → 找到匹配且仍有余量的处理器恢复；
 * - 一旦已有正文/推理/工具调用/finish，说明模型请求已成功，不再恢复（避免半截输出重复、工具副作用重放）。
 *
 * 每个处理器按 `maxAttempts` 限次（同一次 `stream()` 调用内计数）；无处理器可用时按原错误路径上报。
 */
import type { ToolSet } from 'ai';

import { isContextOverflowError } from './overflow-error';

/** 流里的最小 part 形状：只关心 error 与“是否已有模型输出”。 */
export interface ReactiveStreamPart {
    type: string;
    error?: unknown;
}

/** agent.stream 的入参（透传 AI SDK 的 prompt/messages/abortSignal 等）。 */
export type StreamOptions = Record<string, unknown>;

/** 处理器恢复结果：新流 + 其对应的入参（压缩会替换 prompt，后续恢复需基于新入参）。 */
export interface RecoveryResult {
    stream: AsyncIterable<ReactiveStreamPart>;
    options?: StreamOptions;
}

export interface RecoveryContext {
    options: StreamOptions;
    error: unknown;
    /** 本处理器第几次恢复（从 1 开始）。 */
    attempt: number;
    /** 用给定入参重新调用被包装 agent 的 stream()。 */
    restream: (options: StreamOptions) => Promise<AsyncIterable<ReactiveStreamPart>>;
}

/** 首输出前错误的恢复处理器。返回 null 表示无法恢复（调用方按原错误处理）。 */
export interface PreOutputRecoveryHandler {
    id: string;
    maxAttempts: number;
    matches(error: unknown): boolean;
    recover(ctx: RecoveryContext): Promise<RecoveryResult | null>;
}

/**
 * 超窗后重建 prompt 并重新发起流式；返回 null 表示无法重试（调用方按原错误处理）。
 * 可直接返回新流（入参不变），或返回带新入参的 {@link RecoveryResult}（压缩替换了 prompt 时）。
 */
export type ReactiveStreamRetry = (
    options: StreamOptions
) => Promise<AsyncIterable<ReactiveStreamPart> | RecoveryResult | null>;

interface AgentLike {
    version: string;
    id: string | undefined;
    tools: ToolSet;
    generate: (...args: unknown[]) => PromiseLike<unknown>;
    stream: (options: StreamOptions) => PromiseLike<{ stream: ReadableStream<ReactiveStreamPart> }>;
}

/**
 * 非确定性 part：出现在真正模型输出之前，可安全缓冲/丢弃后重试。
 * `start` / `start-step` 只是流生命周期标记，`raw` 是 provider 原始事件（可能先于错误到达）。
 */
const NON_DEFINITIVE_PART_TYPES = new Set(['start', 'start-step', 'raw']);

/** 超窗处理器：只恢复一次（压缩后仍超窗说明没有可压空间）。 */
export function createOverflowHandler(retry: ReactiveStreamRetry): PreOutputRecoveryHandler {
    return {
        id: 'context-overflow',
        maxAttempts: 1,
        matches: isContextOverflowError,
        recover: async ({ options }) => {
            const result = await retry(options);
            if (!result) return null;
            return isAsyncIterable(result) ? { stream: result } : result;
        }
    };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ReactiveStreamPart> {
    return typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

/**
 * 包装 Agent：保持 `tools` / `generate` 原样，只拦截 `stream()` 为“首输出前可恢复”的流。
 * `createAgentUIStream` 只消费返回值的 `.stream`，因此无需完整复刻 StreamTextResult。
 */
export function withPreOutputRecovery<T extends object>(agent: T, handlers: readonly PreOutputRecoveryHandler[]): T {
    const delegate = agent as unknown as AgentLike;
    const restream = async (options: StreamOptions) => (await delegate.stream.call(delegate, options)).stream;

    const wrapped: AgentLike = {
        version: delegate.version,
        id: delegate.id,
        tools: delegate.tools,
        generate: (...args: unknown[]) => Reflect.apply(delegate.generate, delegate, args),
        stream: async (options) => {
            const used = new Map<PreOutputRecoveryHandler, number>();

            const recover = async (
                error: unknown,
                current: StreamOptions
            ): Promise<{ stream: AsyncIterable<ReactiveStreamPart>; options: StreamOptions } | null> => {
                const handler = handlers.find((h) => (used.get(h) ?? 0) < h.maxAttempts && h.matches(error));
                if (!handler) return null;
                const attempt = (used.get(handler) ?? 0) + 1;
                used.set(handler, attempt);
                let result: RecoveryResult | null;
                try {
                    result = await handler.recover({ options: current, error, attempt, restream });
                } catch (next) {
                    // 恢复过程中再次失败（如重试的请求又被限流）：交回处理器链，余量耗尽则抛出新错误
                    const again = await recover(next, current);
                    if (again) return again;
                    throw next;
                }
                if (!result) return null;
                return { stream: result.stream, options: result.options ?? current };
            };

            const probe = (source: AsyncIterable<ReactiveStreamPart>, current: StreamOptions) =>
                probeBeforeStreaming(source, (error) => recover(error, current), probe);

            let first: { stream: ReadableStream<ReactiveStreamPart> };
            try {
                first = await delegate.stream.call(delegate, options);
            } catch (error) {
                // 少数 provider/SDK 会在 stream() 返回前就抛错
                const recovered = await recover(error, options);
                if (!recovered) throw error;
                return { stream: toReadableStream(probe(recovered.stream, recovered.options)) };
            }
            return { stream: toReadableStream(probe(first.stream, options)) };
        }
    };
    return wrapped as unknown as T;
}

/** 仅超窗压缩的便捷包装（只挂一个超窗处理器）。 */
export function withReactiveCompaction<T extends object>(agent: T, retry: ReactiveStreamRetry): T {
    return withPreOutputRecovery(agent, [createOverflowHandler(retry)]);
}

type Recover = (
    error: unknown
) => Promise<{ stream: AsyncIterable<ReactiveStreamPart>; options: StreamOptions } | null>;
type Probe = (source: AsyncIterable<ReactiveStreamPart>, options: StreamOptions) => AsyncIterable<ReactiveStreamPart>;

/** 探测首个确定性 part；在此之前遇到错误则交给处理器链恢复，恢复出的新流继续探测。 */
async function* probeBeforeStreaming(
    source: AsyncIterable<ReactiveStreamPart>,
    recover: Recover,
    probe: Probe
): AsyncGenerator<ReactiveStreamPart> {
    const iterator = source[Symbol.asyncIterator]();
    const buffered: ReactiveStreamPart[] = [];
    // 下游提前取消（用户停止 / 断开）时，生成器在 yield 处被 return：必须把取消传给源迭代器，
    // 否则恢复出来的模型流不会被关闭、继续消耗资源。已自然结束或已主动关闭的源不再重复关闭。
    let settled = false;

    try {
        while (true) {
            let next: IteratorResult<ReactiveStreamPart>;
            try {
                next = await iterator.next();
            } catch (error) {
                settled = true;
                const recovered = await recover(error);
                if (!recovered) throw error;
                await closeQuietly(iterator);
                yield* probe(recovered.stream, recovered.options);
                return;
            }

            if (next.done) {
                settled = true;
                yield* buffered;
                return;
            }

            const part = next.value;
            if (part.type === 'error') {
                const recovered = await recover(part.error);
                if (recovered) {
                    settled = true;
                    await closeQuietly(iterator);
                    yield* probe(recovered.stream, recovered.options);
                    return;
                }
                // 无法恢复：把缓冲的生命周期 part 和错误原样下发，保持既有错误展示
                yield* buffered;
                yield part;
                yield* forwardRemaining(iterator);
                settled = true;
                return;
            }

            if (NON_DEFINITIVE_PART_TYPES.has(part.type)) {
                buffered.push(part);
                continue;
            }

            yield* buffered;
            yield part;
            yield* forwardRemaining(iterator);
            settled = true;
            return;
        }
    } finally {
        if (!settled) await closeQuietly(iterator);
    }
}

async function* forwardRemaining(iterator: AsyncIterator<ReactiveStreamPart>): AsyncGenerator<ReactiveStreamPart> {
    while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
    }
}

async function closeQuietly(iterator: AsyncIterator<unknown>): Promise<void> {
    try {
        await iterator.return?.();
    } catch {
        // 关闭旧流失败不影响重试
    }
}

/** 把异步迭代器包装成 ReadableStream：AI SDK 的 toUIMessageStream 需要 getReader()。 */
function toReadableStream(source: AsyncIterable<ReactiveStreamPart>): ReadableStream<ReactiveStreamPart> {
    const iterator = source[Symbol.asyncIterator]();
    return new ReadableStream<ReactiveStreamPart>({
        async pull(controller) {
            try {
                const next = await iterator.next();
                if (next.done) {
                    controller.close();
                } else {
                    controller.enqueue(next.value);
                }
            } catch (error) {
                controller.error(error);
            }
        },
        async cancel() {
            await iterator.return?.();
        }
    });
}
