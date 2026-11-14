import type { ToolSet } from 'ai';

/**
 * Hooks 端口与工具包装（agent 层只依赖端口，实现由 `modules/hooks` 在装配点注入）。
 *
 * - PreToolUse：在审批管线里执行（见 approval-pipeline.ts），只能放行 / 拒绝 / 要求确认，不改写入参。
 * - PostToolUse：包装工具 execute，原执行完成后跑 hook，把 `additionalContext` / 阻断原因回填给模型。
 */

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface HookToolCall {
    toolName: string;
    input: unknown;
    toolCallId?: string;
}

/** PreToolUse 合并结果；`failed` 表示 hook 故障（非零退出 / 超时 / 启动失败），按 fail-safe 降级为需确认。 */
export interface HookVerdict {
    decision: 'allow' | 'deny' | 'ask' | 'none';
    reason?: string;
    failed?: boolean;
}

/** PostToolUse 合并结果。 */
export interface HookPostResult {
    /** 回传给模型的补充上下文（如格式化 / lint 结果） */
    additionalContext?: string;
    /** hook 判定后置检查未通过（执行已发生，无法撤销，只把原因交给模型处理） */
    blocked?: boolean;
    reason?: string;
}

export interface ToolHookRunner {
    /** 是否有已信任且启用的 hook 匹配该事件 + 工具名（未配置时零开销跳过）。 */
    matches(event: Exclude<HookEvent, 'Stop'>, toolName: string): boolean;
    pre(call: HookToolCall): Promise<HookVerdict>;
    post(call: HookToolCall, output: unknown): Promise<HookPostResult>;
}

/** 把 PostToolUse 结果并入工具产出：对象加 `_hookContext` 字段，字符串追加段落，其它包一层。 */
export function mergeHookContext(output: unknown, post: HookPostResult): unknown {
    const parts: string[] = [];
    if (post.blocked) parts.push(`后置检查未通过：${post.reason || '（hook 未给出原因）'}`);
    if (post.additionalContext) parts.push(post.additionalContext);
    if (parts.length === 0) return output;
    const text = parts.join('\n');
    if (typeof output === 'string') return `${output}\n\n[hook]\n${text}`;
    if (output && typeof output === 'object' && !Array.isArray(output)) return { ...output, _hookContext: text };
    return { result: output, _hookContext: text };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return !!value && typeof value === 'object' && Symbol.asyncIterator in value;
}

/**
 * 按 PostToolUse matcher 包装有 execute 的工具；返回新对象，不修改入参工具（MCP / 技能工具可能被多处共享）。
 * hook 执行失败只告警（由 runner 负责），不影响工具结果；流式产出（AsyncIterable）的工具 v1 不包装。
 */
export function wrapToolsWithHooks<T extends ToolSet>(tools: T, runner?: ToolHookRunner): T {
    if (!runner) return tools;
    const out: ToolSet = {};
    for (const [name, original] of Object.entries(tools)) {
        const execute = original.execute;
        if (!execute || !runner.matches('PostToolUse', name)) {
            out[name] = original;
            continue;
        }
        out[name] = {
            ...original,
            execute: async (input: unknown, options: { toolCallId?: string }) => {
                const output: unknown = await (execute as (i: unknown, o: unknown) => unknown)(input, options);
                if (isAsyncIterable(output)) return output;
                const post = await runner.post({ toolName: name, input, toolCallId: options?.toolCallId }, output);
                return mergeHookContext(output, post);
            }
        } as ToolSet[string];
    }
    return out as T;
}
