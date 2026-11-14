import { useRequest } from 'ahooks';
import type { UIMessage } from 'ai';
import { useMemo } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchModelConfigApi } from '@/services';
import { resolveContextWindow } from '@/utils/resolveContextWindow';

/** 后端经 messageMetadata 挂在 assistant 消息 metadata 上的 usage 形状（字段均可能缺失）。 */
interface UsageMeta {
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        cacheWriteTokens?: number;
    };
}

/** useTokenUsage 的派生返回态：当前上下文占用 + 相对激活模型上下文窗口的剩余量。 */
export interface TokenUsageResult {
    /** 当前上下文占用 token（取最近一轮 assistant 的 totalTokens，近似「现在喂给模型的大小」）。 */
    usedTokens: number;
    /** 最近一轮 inputTokens（供 hover 明细）。 */
    inputTokens: number;
    /** 最近一轮 outputTokens（供 hover 明细）。 */
    outputTokens: number;
    /** 最近一轮 cached 输入 token；该轮未返回缓存信息时为 undefined。 */
    cachedTokens?: number;
    /** 最近一轮写入缓存的输入 token（Anthropic prompt caching）；未返回时为 undefined。 */
    cacheWriteTokens?: number;
    /** 激活模型上下文窗口上限；未配置 / 未知时 undefined（触发降级）。 */
    contextWindow?: number;
    /** 剩余上下文 token（上限 − 最近一轮 totalTokens，clamp 到 [0, 上限]）；上限未知时 undefined。 */
    remaining?: number;
    /** 剩余上下文百分比（0-100）；上限未知时 undefined。 */
    remainingPercent?: number;
    /** 是否存在任一带有效 usage 的 assistant 消息。 */
    hasUsage: boolean;
    /** 模型配置请求进行中（上下文窗口尚未解析）。 */
    loading: boolean;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

interface LatestUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
    hasUsage: boolean;
}

/**
 * 取最近一轮带有效 usage 的 assistant 消息的用量，近似「当前上下文占用」。
 *
 * 不跨轮累加：每一轮的 inputTokens 已经把之前整段历史重新计入，累加各轮 totalTokens 会把重叠的
 * 上下文反复计数而严重虚高（可远超窗口上限），且压缩后无法回落、与「剩余上下文」口径自相矛盾。
 * 改取最近一轮即可随压缩实时回落，并与剩余量口径自洽（已用 + 剩余 ≈ 上限）。
 */
function pickLatestUsage(messages: UIMessage[]): LatestUsage {
    const empty: LatestUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedTokens: undefined,
        cacheWriteTokens: undefined,
        hasUsage: false
    };

    // 倒序：只要「最近一轮」有效 usage。流式中每个 token 都会重算一次，全量正序遍历会在长会话里放大成本。
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'assistant') continue;
        const usage = (msg.metadata as UsageMeta | undefined)?.usage;
        if (!usage) continue;
        const input = usage.inputTokens ?? 0;
        const output = usage.outputTokens ?? 0;
        const total = usage.totalTokens ?? input + output;
        if (total <= 0 && input <= 0 && output <= 0) continue;
        return {
            inputTokens: input,
            outputTokens: output,
            totalTokens: total,
            cachedTokens: typeof usage.cachedInputTokens === 'number' ? usage.cachedInputTokens : undefined,
            cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : undefined,
            hasUsage: true
        };
    }

    return empty;
}

/**
 * 会话 token 用量派生 hook。
 *
 * 从当前会话 `messages` 最近一轮带有效 usage 的 assistant 消息（后端透传 `metadata.usage`）取当前上下文
 * 占用，并结合激活模型的上下文窗口上限算出剩余上下文。usage 缺失 / 上限未知 / 取数失败均安全降级，不
 * 抛异常、不产出 NaN。上限经 `useRequest(fetchModelConfigApi)` 取一次（默认仅挂载时；切模型联动以重挂载
 * / 会话切换重取为准）。
 *
 * @param messages 当前会话消息（来自 useChat 的 ai.messages）
 * @returns 展示所需的派生用量态
 */
export function useTokenUsage(messages: UIMessage[]): TokenUsageResult {
    const { data, loading } = useRequest(
        async () => {
            const res = await fetchModelConfigApi();
            return res.code === SUCCESS_CODE ? res.data : undefined;
        },
        // 切模型多在「设置」页完成，返回会话时本组件重挂载即重取；再叠加窗口聚焦刷新兜底实时性
        { refreshOnWindowFocus: true }
    );

    const latest = useMemo(() => pickLatestUsage(messages), [messages]);

    const contextWindow = resolveContextWindow(data, data?.activeModel);
    let remaining: number | undefined;
    let remainingPercent: number | undefined;
    if (contextWindow !== undefined) {
        remaining = clamp(contextWindow - latest.totalTokens, 0, contextWindow);
        remainingPercent = clamp((remaining / contextWindow) * 100, 0, 100);
    }

    return {
        usedTokens: latest.totalTokens,
        inputTokens: latest.inputTokens,
        outputTokens: latest.outputTokens,
        cachedTokens: latest.cachedTokens,
        cacheWriteTokens: latest.cacheWriteTokens,
        contextWindow,
        remaining,
        remainingPercent,
        hasUsage: latest.hasUsage,
        loading
    };
}
