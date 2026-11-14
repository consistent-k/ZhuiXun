/**
 * prepareStep 组合器：轮内压缩、缓存断点、护栏纠偏提示各自是独立的 prepareStep 片段，
 * ToolLoopAgent 只接受一个 prepareStep，这里按顺序依次执行并合并结果。
 *
 * 合并规则：后一个片段看到的是前面片段改写后的 `messages` / `instructions`（链式传递）；
 * 其余字段后者覆盖前者。所有片段都返回 undefined 时整体返回 undefined（走 SDK 默认，不做无谓替换）。
 */
import type { Instructions, ModelMessage } from 'ai';

export interface PrepareStepInput {
    messages: ModelMessage[];
    steps: readonly unknown[];
    instructions?: Instructions;
    [key: string]: unknown;
}

export type PrepareStepResultLike = { messages?: ModelMessage[]; instructions?: Instructions; [key: string]: unknown };

export type PrepareStepPart = (
    input: PrepareStepInput
) => PrepareStepResultLike | undefined | Promise<PrepareStepResultLike | undefined>;

/**
 * 组合多个 prepareStep 片段。
 *
 * @param parts 按执行顺序排列的片段；undefined 会被忽略，便于按条件挂载
 */
export function composePrepareStep(...parts: Array<PrepareStepPart | undefined>) {
    const active = parts.filter((p): p is PrepareStepPart => !!p);
    return async (input: PrepareStepInput): Promise<PrepareStepResultLike | undefined> => {
        let current = input;
        let merged: PrepareStepResultLike | undefined;
        for (const part of active) {
            const result = await part(current);
            if (!result) continue;
            merged = { ...merged, ...result };
            current = {
                ...current,
                ...(result.messages ? { messages: result.messages } : {}),
                ...(result.instructions !== undefined ? { instructions: result.instructions } : {})
            };
        }
        return merged;
    };
}
