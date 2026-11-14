import type { TextStreamPart, ToolSet } from 'ai';

/** 只读观察回调：不改写 part，也不改变顺序。 */
export type StreamPartObserver = (part: TextStreamPart<ToolSet>) => void;

interface StreamingAgent {
    version: string;
    id: string | undefined;
    tools: ToolSet;
    generate: (...args: unknown[]) => PromiseLike<unknown>;
    stream: (options: unknown) => PromiseLike<{ stream: ReadableStream<TextStreamPart<ToolSet>> }>;
}

/**
 * 包装 Agent，在 `toUIMessageStream` 之前逐个观察模型流 part。
 *
 * 为什么不在 createAgentUIStream 的 onError 里判失败：AI SDK 也用同一个 onError 为每个 tool-error
 * 生成 errorText，那里分不清「工具出错（模型可继续处理）」与「流级错误（整轮失败）」。
 * 在上游观察能拿到 part 类型，且观察必然先于下游对后续 finish part 的处理。
 * 与 withPreOutputRecovery 一致，createAgentUIStream 只消费返回值的 `.stream`。
 */
export function withStreamObserver<T extends object>(agent: T, observe: StreamPartObserver): T {
    const delegate = agent as unknown as StreamingAgent;
    const wrapped: StreamingAgent = {
        version: delegate.version,
        id: delegate.id,
        tools: delegate.tools,
        generate: (...args: unknown[]) => Reflect.apply(delegate.generate, delegate, args),
        stream: async (options) => {
            const result = await delegate.stream.call(delegate, options);
            return {
                stream: result.stream.pipeThrough(
                    new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
                        transform(part, controller) {
                            observe(part);
                            controller.enqueue(part);
                        }
                    })
                )
            };
        }
    };
    return wrapped as unknown as T;
}
