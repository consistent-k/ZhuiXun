/**
 * 上下文压缩策略的唯一真源：上下文窗口 → 输出预留 → 触发阈值 → 微压缩阈值。
 *
 * 关键口径（对齐 ZCode 的 auto compact policy）：
 * - provider 的 contextWindow 是「输入 + 输出」共享窗口，压缩只能让出输入侧，所以阈值分母必须先扣掉
 *   模型的输出预留（最多 21k），否则长回答会踩线。
 * - 再按窗口比例留最多 13k buffer，避免估算误差/多模态开销导致刚好超窗。
 * - 用户设置的是百分比（50~95），最终阈值取「百分比阈值」与「有效窗口 - buffer」的较小值，
 *   既保留用户“早压/晚压”的控制，又永远不越过安全线。
 *
 * 跨轮压缩（compactor）与轮内压缩（step-compactor）共用本文件，避免两套估算/两套阈值漂移。
 */
import type { ResolvedModel } from '@/config/types';

/** 模型未配置 contextWindow 时的兜底上下文窗口（token）。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
/** 为模型输出预留的窗口上限（token）；与 ZCode 的 PREFLIGHT 预留保持一致。 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 21_000;
/** 触发压缩前额外保留的安全 buffer（token）。 */
export const COMPACTION_BUFFER_TOKENS = 13_000;
/** 保留区目标预算占有效上下文窗口的比例（近期消息原样保留的额度）。 */
export const KEEP_RATIO = 0.3;
/** 反应式压缩（provider 报超窗后）用的保留比例：比常规更激进，尽量一次压够。 */
export const REACTIVE_KEEP_RATIO = 0.1;
/** 至少保留的近期消息条数（避免当前轮也被压缩）；约 1 轮对话。 */
export const MIN_KEEP_MESSAGES = 2;
/** 可压缩的早期消息至少要有这么多条，否则不值得摘要；约 1 轮对话。 */
export const MIN_COMPRESS_MESSAGES = 2;
/** 连续摘要失败多少次后暂停自动压缩（避免每轮白花一次摘要调用）。 */
export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;
/** 微压缩保留最近多少个工具结果分组（按消息分组，组内并行工具一起保留）。 */
export const MICROCOMPACT_KEEP_RECENT_GROUPS = 5;
/** 微压缩至少节省这么多 token 才值得改消息（避免为了几十 token 重写历史）。 */
export const MICROCOMPACT_MIN_SAVINGS_TOKENS = 256;
/** 微压缩阈值 = min(触发阈值 × 该比例, 触发阈值 - buffer)，比全量压缩更早触发。 */
export const MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;

export interface CompactionPolicy {
    /** 模型原始上下文窗口（已兜底为默认值）。 */
    contextWindow: number;
    /** 为输出预留的 token（已按上下文窗口收敛）。 */
    outputReserveTokens: number;
    /** 输入侧可用窗口 = contextWindow - outputReserveTokens。 */
    effectiveContextWindow: number;
    /** 触发全量语义压缩的阈值（token）。 */
    compactThreshold: number;
    /** 触发确定性工具结果清理的阈值（token）。 */
    microcompactThreshold: number;
}

/**
 * 解析当前模型 + 用户设置下的压缩策略。
 *
 * @param model 已解析模型（取 contextWindow；缺省用兜底常量）
 * @param thresholdPercent 用户设置的触发百分比（50~95，超出会被 clamp）
 */
export function resolveCompactionPolicy(model: ResolvedModel, thresholdPercent: number): CompactionPolicy {
    const contextWindow = positiveInt(model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const outputReserveTokens = Math.min(DEFAULT_OUTPUT_RESERVE_TOKENS, Math.floor(contextWindow * 0.25));
    const effectiveContextWindow = Math.max(0, contextWindow - outputReserveTokens);
    const percent = Math.min(100, Math.max(1, Math.round(thresholdPercent)));
    const percentThreshold = Math.floor((effectiveContextWindow * percent) / 100);
    // 小窗口按比例留余量，避免固定预留把触发阈值压到零。
    const buffer = Math.min(COMPACTION_BUFFER_TOKENS, Math.floor(effectiveContextWindow * 0.2));
    const safeThreshold = effectiveContextWindow - buffer;
    const compactThreshold = Math.min(percentThreshold, safeThreshold);
    const microcompactThreshold = Math.max(
        0,
        Math.min(
            Math.floor(compactThreshold * MICROCOMPACT_THRESHOLD_RATIO),
            compactThreshold - MICROCOMPACT_THRESHOLD_BUFFER_TOKENS
        )
    );
    return {
        contextWindow,
        outputReserveTokens,
        effectiveContextWindow,
        compactThreshold,
        microcompactThreshold
    };
}

function positiveInt(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.floor(value);
}
