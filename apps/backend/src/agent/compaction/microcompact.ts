/**
 * 跨轮确定性微压缩（对齐 ZCode 的 microcompact）：不调 LLM，只把**较早的**工具产出替换成占位符，
 * 保留最近若干个工具结果分组。用于在触发昂贵的语义摘要之前，先廉价地回收上下文。
 *
 * 与 step-compactor 的分工：
 * - 本文件处理「跨轮历史」里的旧工具产出（每轮请求前跑一次，能否省下摘要调用取决于结果）；
 * - step-compactor 处理「同一轮工具循环内」累积的推理/工具调用（prepareStep 里跑）。
 *
 * 关键安全约束：只改「喂给模型的数组」，不改磁盘/界面消息；工具调用与结果的配对关系保持不变
 * （只替换 output 内容），因此不会触发 provider 的 tool_call/tool_result 校验错误。
 */
import type { UIMessage } from 'ai';

import { MICROCOMPACT_KEEP_RECENT_GROUPS, MICROCOMPACT_MIN_SAVINGS_TOKENS } from './policy';
import { estimateMessagesTokens } from './token-estimate';

/** 被清理的工具产出占位符：让模型明确知道“这里曾有工具结果，但已为省上下文清理”。 */
export const CLEARED_TOOL_OUTPUT = '[旧工具输出已清理以节省上下文]';

/** 允许清理产出的工具：内置文件/检索/命令工具 + MCP（它们通常是上下文大户）。 */
const COMPACTABLE_TOOL_NAMES = new Set([
    'Read',
    'Write',
    'Edit',
    'Grep',
    'Glob',
    'LS',
    'Bash',
    'WebFetch',
    'WebSearch',
    'ApplyPatch'
]);

const MEDIA_PART_TYPES = new Set(['image', 'file', 'video']);

interface LooseToolPart {
    type?: string;
    toolName?: string;
    state?: string;
    output?: unknown;
}

export interface MicrocompactOptions {
    /** 估算 token 达到该值才尝试清理；传 0 表示强制清理（反应式压缩用）。 */
    thresholdTokens: number;
    /** 保留最近多少个工具结果分组；缺省 5。 */
    keepRecentGroups?: number;
    /** 至少节省多少 token 才真正生效；缺省 256。 */
    minSavingsTokens?: number;
}

export interface MicrocompactResult {
    /** 清理后的消息数组；未生效时返回原数组引用。 */
    messages: UIMessage[];
    clearedCount: number;
    savedTokens: number;
}

/**
 * 清理较早的工具产出。
 *
 * 按「消息」分组（同一 assistant 消息里并行调用的多个工具算一组），保留最近 N 组不动；
 * 只清理白名单工具、已成功产出、且不含图片/文件/视频的结果；错误结果保留（通常很短且对排障有用）。
 */
export function microcompactMessages(messages: UIMessage[], options: MicrocompactOptions): MicrocompactResult {
    if (messages.length === 0) return { messages, clearedCount: 0, savedTokens: 0 };

    const before = estimateMessagesTokens(messages);
    if (before < options.thresholdTokens) return { messages, clearedCount: 0, savedTokens: 0 };

    const groups = collectClearableGroups(messages);
    const keepRecentGroups = Math.max(1, options.keepRecentGroups ?? MICROCOMPACT_KEEP_RECENT_GROUPS);
    if (groups.length <= keepRecentGroups) return { messages, clearedCount: 0, savedTokens: 0 };

    const next = [...messages];
    let clearedCount = 0;
    for (const group of groups.slice(0, groups.length - keepRecentGroups)) {
        const message = next[group.messageIndex];
        const parts = [...((message.parts ?? []) as LooseToolPart[])];
        for (const partIndex of group.partIndexes) {
            parts[partIndex] = { ...parts[partIndex], output: CLEARED_TOOL_OUTPUT };
            clearedCount++;
        }
        next[group.messageIndex] = { ...message, parts } as UIMessage;
    }

    const savedTokens = Math.max(0, before - estimateMessagesTokens(next));
    const minSavings = options.minSavingsTokens ?? MICROCOMPACT_MIN_SAVINGS_TOKENS;
    if (savedTokens < minSavings) return { messages, clearedCount: 0, savedTokens: 0 };

    return { messages: next, clearedCount, savedTokens };
}

interface ClearableGroup {
    messageIndex: number;
    partIndexes: number[];
}

/** 收集含可清理工具结果的消息分组（按消息分组，保留并行调用的整体性）。 */
function collectClearableGroups(messages: UIMessage[]): ClearableGroup[] {
    const groups: ClearableGroup[] = [];
    messages.forEach((message, messageIndex) => {
        const parts = Array.isArray(message.parts) ? (message.parts as LooseToolPart[]) : [];
        const partIndexes: number[] = [];
        parts.forEach((part, partIndex) => {
            if (isClearableToolPart(part)) partIndexes.push(partIndex);
        });
        if (partIndexes.length > 0) groups.push({ messageIndex, partIndexes });
    });
    return groups;
}

function isClearableToolPart(part: LooseToolPart): boolean {
    if (!part || typeof part !== 'object') return false;
    // 错误/拒绝/待审批的 part 保留：通常很小，且对模型理解失败原因很重要
    if (part.state === 'output-error' || part.state === 'output-denied') return false;
    if (part.output === undefined || part.output === CLEARED_TOOL_OUTPUT) return false;
    if (hasMediaOutput(part.output)) return false;
    const name = toolNameOf(part);
    return name !== undefined && (COMPACTABLE_TOOL_NAMES.has(name) || name.startsWith('mcp__'));
}

function toolNameOf(part: LooseToolPart): string | undefined {
    if (part.type === 'dynamic-tool') return part.toolName;
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) return part.type.slice(5);
    return undefined;
}

/** 图片/文件/视频输出不清：它们可能是后续推理的唯一依据，且占位符无法表达其内容。 */
function hasMediaOutput(output: unknown): boolean {
    if (!output || typeof output !== 'object') return false;
    if (Array.isArray(output)) {
        return output.some((item) => isMediaPart(item));
    }
    return isMediaPart(output);
}

function isMediaPart(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' && MEDIA_PART_TYPES.has(type);
}
