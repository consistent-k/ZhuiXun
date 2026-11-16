/**
 * 上下文自动压缩编排（类 Claude Code /compact）。
 *
 * 在 `/api/chat/stream` 把「归一化后的全量历史」喂给 agent 之前调用：读会话压缩检查点 → 重建模型输入
 * （摘要 + 边界之后的近期消息）→ 先做确定性微压缩 → 按上一轮用量判阈 → 必要时摘要早期消息并写入新检查点。
 *
 * 关键原则：
 * - 非破坏式：磁盘与界面始终保留全量原始 messages，这里只改「喂给模型的数组」；检查点与原文分离存储。
 * - 检查点滚动：命中检查点的每轮都复用摘要（不重复摘要）；只有近期消息再次涨过阈值才滚动再压缩。
 * - 两级压缩：先用零 LLM 的微压缩清掉较早工具产出（省一次摘要调用），仍超阈才做语义摘要。
 * - best-effort + 熔断：摘要失败/条件不足一律降级为已有检查点重建的输入或原样全量，绝不抛错阻断作答；
 *   连续失败 3 次后暂停自动压缩，避免每轮白花一次摘要调用。
 * - 工具完整性：压缩边界只落在 user 消息（一轮之始），不切断同一轮内的工具调用/结果 part。
 * - 判阈信号：上一轮 assistant 的 usage 取**最后一步**（即当时的上下文大小），而不是整轮所有 step 的累加。
 */
import { createHash } from 'node:crypto';

import { getToolName, isToolUIPart, type UIMessage } from 'ai';

import { getAppSettings } from '@/config/settings-store';
import type { ResolvedModel } from '@/config/types';
import type { getConversationStore } from '@/modules/conversations';
import type { CompactionCheckpoint, SavedConversation } from '@/modules/conversations';
import { createLogger } from '@/platform/logging/index';

import { microcompactMessages } from './microcompact';
import {
    KEEP_RATIO,
    MAX_CONSECUTIVE_COMPACTION_FAILURES,
    MIN_COMPRESS_MESSAGES,
    MIN_KEEP_MESSAGES,
    REACTIVE_KEEP_RATIO,
    resolveCompactionPolicy
} from './policy';
import { generateCompactionSummary } from './summarizer';
import { estimateMessageTokens, estimateMessagesTokens } from './token-estimate';
import type { CompactionMarker } from './types';

const log = createLogger('ContextCompaction');

/** 会话仓储类型（store 为私有类，经单例工厂的返回类型取得其实例类型）。 */
type ConversationStore = ReturnType<typeof getConversationStore>;

/** 单次摘要限制输入体积；超长历史按原顺序分批滚动归并。 */
const MAX_TRANSCRIPT_CHARS = 24_000;
const MIN_TRANSCRIPT_CHARS = 1000;
const MAX_TOOL_EXCERPT_CHARS = 480;
const MAX_TOOL_EXCERPTS_PER_MESSAGE = 6;
/** 连续失败计数的有效期。 */
const FAILURE_TTL_MS = 30 * 60_000;

function excerpt(value: unknown): string {
    if (value === undefined) return '';
    try {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (!text) return '';
        if (text.length <= MAX_TOOL_EXCERPT_CHARS) return text;
        const half = Math.floor(MAX_TOOL_EXCERPT_CHARS / 2);
        return `${text.slice(0, half)}…${text.slice(-half)}`;
    } catch {
        return '';
    }
}

function transcriptLine(message: UIMessage): string {
    const parts = message.parts ?? [];
    const text = parts.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
    const tools = parts.filter(isToolUIPart);
    const files = parts.filter((part) => part.type === 'file').length;
    const results = tools.slice(0, MAX_TOOL_EXCERPTS_PER_MESSAGE).map((part) => {
        const result = 'output' in part ? excerpt(part.output) : 'errorText' in part ? excerpt(part.errorText) : '';
        return [getToolName(part), part.state, excerpt(part.input), result].filter(Boolean).join(' | ');
    });
    const body = [text, tools.length ? `[工具调用x${tools.length}]` : '', files ? `[附件x${files}]` : '', ...results]
        .filter(Boolean)
        .join(' ');
    return body.trim() ? `${message.role === 'assistant' ? '助手' : '用户'}：${body}` : '';
}

function* buildTranscripts(messages: UIMessage[], budget: number): Generator<string> {
    let batch = '';
    let turn = '';
    function* append(text: string): Generator<string> {
        if (batch && batch.length + text.length + 1 > budget) {
            yield batch;
            batch = '';
        }
        while (text.length > budget) {
            yield text.slice(0, budget);
            text = text.slice(budget);
        }
        if (text) batch = batch ? `${batch}\n${text}` : text;
    }
    for (const message of messages) {
        if (message.role === 'user' && turn) {
            yield* append(turn);
            turn = '';
        }
        const line = transcriptLine(message);
        if (line) turn = turn ? `${turn}\n${line}` : line;
    }
    if (turn) yield* append(turn);
    if (batch) yield batch;
}

/** 历史用量只对同一模型和检查点有效，旧会话缺少记录时改走估算。 */
export function compactionUsageScope(model: ResolvedModel, checkpoint?: CompactionCheckpoint): string {
    return createHash('sha256')
        .update(JSON.stringify([model.kind, model.baseURL, model.modelName, model.contextWindow, checkpoint]))
        .digest('hex');
}

function readPrevTotalTokens(metadata: unknown, scope: string): number | undefined {
    const entry = metadata as
        | {
              usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
              compactionUsageScope?: string;
          }
        | undefined;
    if (entry?.compactionUsageScope !== scope || !entry.usage) return undefined;
    const usage = entry.usage;
    if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) return usage.totalTokens;
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    return total > 0 ? total : undefined;
}

/**
 * 按检查点重建喂给模型的输入：摘要文本并入「保留区首条（user）消息」，其后原样保留。
 * 把摘要并进首条 user 消息而非新插一条，是为规避「首条须 user / 不得连续同角色」等 provider 约束。
 * 边界消息找不到（历史被改动）时返回原数组（安全降级）。
 */
function applyCheckpoint(messages: UIMessage[], checkpoint: CompactionCheckpoint): UIMessage[] {
    const idx = messages.findIndex((m) => m.id === checkpoint.boundaryMessageId);
    if (idx <= 0) return messages;
    const tail = messages.slice(idx);
    const first = tail[0];
    const summaryText = `以下是本次对话早先内容的摘要（为节省上下文自动生成，仅作背景参考）：\n\n${checkpoint.summary}`;
    const summaryPart = { type: 'text' as const, text: summaryText };
    const injected = {
        ...first,
        parts: [summaryPart, ...((first.parts ?? []) as unknown[])]
    } as UIMessage;
    return [injected, ...tail.slice(1)];
}

interface BoundaryPlan {
    boundaryIndex: number;
    boundaryId: string;
    keptCount: number;
}

/**
 * 选择压缩边界：保留最近若干消息（原文），其余折叠进摘要；边界落在 user 消息（整轮完整、不切断工具 part）。
 *
 * 保留量的确定分两种情形，关键是**不能因字符估算偏小就放弃压缩**：
 * - 近期消息的估算 token 已达「保留预算」(keepBudget)：按估算保留这批近期消息（长文本场景，估算较可信）。
 * - 估算始终不到保留预算、但本会话已判定超阈：说明字符估算显著低于真实用量（系统提示、工具产出等不计入消息文本），
 *   此时**激进压缩**——只保留最近 MIN_KEEP_MESSAGES 条，其余全部摘要（修复「真实用量 45k 却因估算小而不压缩」的问题）。
 *
 * 消息不足以拆分（少于 MIN_COMPRESS_MESSAGES + MIN_KEEP_MESSAGES 条）时返回 null。
 */
function planBoundary(messages: UIMessage[], keepBudget: number): BoundaryPlan | null {
    const n = messages.length;
    if (n < MIN_COMPRESS_MESSAGES + MIN_KEEP_MESSAGES) return null;
    const maxKeep = n - MIN_COMPRESS_MESSAGES; // 至少留 MIN_COMPRESS 条用于摘要

    let acc = 0;
    let kept = 0;
    let reachedBudget = false;
    for (let i = n - 1; i >= 0 && kept < maxKeep; i--) {
        acc += estimateMessageTokens(messages[i]);
        kept++;
        if (acc >= keepBudget && kept >= MIN_KEEP_MESSAGES) {
            reachedBudget = true;
            break;
        }
    }
    // 估算没撑满保留预算：字符估算低估真实用量 → 激进只留最近 MIN_KEEP_MESSAGES 条
    if (!reachedBudget) kept = MIN_KEEP_MESSAGES;
    kept = Math.min(Math.max(kept, MIN_KEEP_MESSAGES), maxKeep);

    let boundary = n - kept;
    // 吸附到 user 消息边界（保证保留区从「一轮之始」开始、不切断同轮工具 part）。
    // 优先向更早的 user 吸附（保留整轮近期上下文）；若这样会使可摘要消息不足 MIN_COMPRESS，则改向更晚的 user 吸附。
    let earlier = boundary;
    while (earlier > 0 && messages[earlier].role !== 'user') earlier--;
    if (earlier >= MIN_COMPRESS_MESSAGES) {
        boundary = earlier;
    } else {
        let later = boundary;
        while (later < n && messages[later].role !== 'user') later++;
        boundary = later;
    }
    if (boundary < MIN_COMPRESS_MESSAGES || boundary >= n) return null;
    const boundaryId = messages[boundary].id;
    if (!boundaryId) return null;
    return { boundaryIndex: boundary, boundaryId, keptCount: n - boundary };
}

export interface CompactionOutcome {
    /** 实际喂给模型的消息数组（可能是微压缩/摘要重建后的，也可能原样）。 */
    modelInput: UIMessage[];
    /** 本轮确实发生了语义压缩时的展示标记；否则 undefined。 */
    marker?: CompactionMarker;
    /** 模型输入是否真的变小/被改写（反应式压缩据此决定是否值得重试，避免用同一份 prompt 再撞一次）。 */
    changed: boolean;
    usageScope?: string;
    conflict?: boolean;
}

export interface CompactContextParams {
    /** 会话仓储（读/写检查点） */
    store: ConversationStore;
    /** 会话 id */
    sessionId: string;
    /** 归一化后的全量历史（UIMessage[]） */
    messages: UIMessage[];
    /** 已解析模型（取 contextWindow 作预算，复用其通道做摘要） */
    model: ResolvedModel;
    /** 确定要摘要、即将发起摘要模型调用前回调一次（供前端展示「压缩中」）。只在真正触发压缩时调用。 */
    onCompacting?: () => void;
    signal?: AbortSignal;
}

export interface ForceCompactParams extends CompactContextParams {
    /** 用户给出的摘要保留要点（如「保留方案调整的结论」） */
    instructions?: string;
    snapshot?: SavedConversation;
}

interface CompactionRunOptions {
    /** 跳过阈值判断（反应式压缩：已经超窗，必须压）。 */
    force: boolean;
    /** 保留区目标预算占有效窗口的比例。 */
    keepRatio: number;
    /** 跳过连续失败熔断（反应式压缩是最后机会）。 */
    bypassFailureBreaker?: boolean;
    /** 不受「上下文压缩」开关影响（用户显式 /compact）。 */
    manual?: boolean;
    failedInput?: UIMessage[];
    snapshot?: SavedConversation;
    /** 摘要额外要求。 */
    instructions?: string;
}

// 连续失败计数：按会话隔离、内存态、30 分钟过期。压缩失败不落盘，重启后重新计数。
const compactionFailures = new Map<string, { count: number; at: number }>();

function consecutiveFailures(sessionId: string): number {
    const record = compactionFailures.get(sessionId);
    if (!record) return 0;
    if (Date.now() - record.at > FAILURE_TTL_MS) {
        compactionFailures.delete(sessionId);
        return 0;
    }
    return record.count;
}

function noteCompactionFailure(sessionId: string): void {
    const now = Date.now();
    const record = compactionFailures.get(sessionId);
    const previous = record && now - record.at <= FAILURE_TTL_MS ? record.count : 0;
    compactionFailures.set(sessionId, { count: previous + 1, at: now });
    // 顺手清理过期项，避免长跑进程里 map 无限增长
    if (compactionFailures.size > 200) {
        for (const [id, item] of compactionFailures) {
            if (now - item.at > FAILURE_TTL_MS) compactionFailures.delete(id);
        }
    }
}

function resetCompactionFailures(sessionId: string): void {
    compactionFailures.delete(sessionId);
}

/**
 * 判阈并（必要时）压缩上下文（常规自动压缩）。
 *
 * @param params.store 会话仓储（读/写检查点）
 * @param params.sessionId 会话 id
 * @param params.messages 归一化后的全量历史（UIMessage[]）
 * @param params.model 已解析模型（取 contextWindow 作预算，复用其通道做摘要）
 */
export async function maybeCompactContext(params: CompactContextParams): Promise<CompactionOutcome> {
    return runCompaction(params, { force: false, keepRatio: KEEP_RATIO });
}

/**
 * 反应式压缩：provider 已报上下文超限后调用。跳过百分位阈值与失败熔断，用更小的保留区强制压一次；
 * 若没有可压缩空间（例如单条超长附件）则返回原输入，调用方按原错误处理。
 */
export async function reactiveCompactContext(
    params: CompactContextParams,
    failedInput?: UIMessage[]
): Promise<CompactionOutcome> {
    return runCompaction(params, {
        force: true,
        keepRatio: REACTIVE_KEEP_RATIO,
        failedInput,
        bypassFailureBreaker: true
    });
}

/**
 * 手动压缩（`/compact`）：跳过阈值、熔断与开关，按常规保留比例（比反应式保留更多近期消息）压一次，
 * 可附带摘要保留要点。无可压缩内容时 `changed=false` 且无 marker。
 */
export async function forceCompactContext(params: ForceCompactParams): Promise<CompactionOutcome> {
    return runCompaction(params, {
        force: true,
        keepRatio: KEEP_RATIO,
        bypassFailureBreaker: true,
        manual: true,
        snapshot: params.snapshot,
        instructions: params.instructions
    });
}

async function runCompaction(params: CompactContextParams, options: CompactionRunOptions): Promise<CompactionOutcome> {
    const { store, sessionId, messages, model, onCompacting, signal } = params;
    const cfg = getAppSettings();
    const conv = options.snapshot ?? (await store.get(sessionId));
    const storedBoundaryIndex = conv?.compaction
        ? messages.findIndex((m) => m.id === conv.compaction?.boundaryMessageId && m.role === 'user')
        : -1;
    const checkpoint = storedBoundaryIndex > 0 ? conv?.compaction : undefined;
    const reconstructed = checkpoint ? applyCheckpoint(messages, checkpoint) : messages;
    const usageScope = compactionUsageScope(model, checkpoint);
    if (!cfg.autoCompactEnabled && !options.manual) {
        // 开关只控制是否发起压缩，已经提交的手动检查点仍然需要应用。
        return { modelInput: reconstructed, changed: false, usageScope };
    }
    const policy = resolveCompactionPolicy(model, cfg.autoCompactThreshold);
    const retryBudget = options.failedInput ? estimateMessagesTokens(options.failedInput) : undefined;
    const micro = microcompactMessages(reconstructed, {
        thresholdTokens: options.force ? 0 : policy.microcompactThreshold
    });
    const estimated = estimateMessagesTokens(micro.messages);
    const fallback = {
        modelInput: micro.messages,
        changed: retryBudget === undefined ? micro.savedTokens > 0 : estimated < retryBudget,
        usageScope
    };

    // 用量必须对应请求实际带上的最后一条助手消息，避免回滚、切模型或新检查点后沿用错误基线。
    let lastAssistantIdx = messages.length - 1;
    while (lastAssistantIdx >= 0 && messages[lastAssistantIdx].role !== 'assistant') lastAssistantIdx--;
    const lastAssistant = messages[lastAssistantIdx];
    const storedAssistant = conv?.messages.find((message) => message.id === lastAssistant?.id);
    const prevTotal = readPrevTotalTokens(storedAssistant?.metadata ?? lastAssistant?.metadata, usageScope);
    let projected = estimated;
    if (prevTotal !== undefined) {
        let incrementalSaved = 0;
        if (micro.savedTokens > 0) {
            const previousInput = messages.slice(0, lastAssistantIdx + 1);
            const previousMicro = microcompactMessages(
                checkpoint ? applyCheckpoint(previousInput, checkpoint) : previousInput,
                { thresholdTokens: policy.microcompactThreshold }
            );
            incrementalSaved = Math.max(0, micro.savedTokens - previousMicro.savedTokens);
        }
        projected = Math.max(
            estimated,
            prevTotal - incrementalSaved + estimateMessagesTokens(messages.slice(lastAssistantIdx + 1))
        );
    }

    if (!options.force && projected < policy.compactThreshold) {
        return fallback;
    }

    if (!options.bypassFailureBreaker) {
        const failures = consecutiveFailures(sessionId);
        if (failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES) {
            log.warn('连续压缩失败达到上限，本轮跳过自动压缩', { sessionId, failures });
            return fallback;
        }
    }

    // 需要压缩：规划新边界（基于全量 messages），保留预算按有效窗口（已扣输出预留）× 保留比例。
    const keepBudget = policy.effectiveContextWindow * options.keepRatio;
    const plan = planBoundary(messages, keepBudget);
    const prevBoundary = checkpoint ? storedBoundaryIndex : 0;
    // 无可压缩空间，或新边界未向前推进（无进展）：降级为微压缩后的输入
    if (!plan || plan.boundaryIndex <= prevBoundary) {
        return fallback;
    }

    // 待并入摘要的早期消息：仅取「上次边界 → 新边界」之间（之前的已折进 checkpoint.summary）
    const head = messages.slice(prevBoundary, plan.boundaryIndex);
    if (!conv || signal?.aborted) return fallback;
    // 小窗口也要容纳滚动摘要、指令和模型输出，所以每批只使用部分输入额度。
    const batchBudget = Math.min(MAX_TRANSCRIPT_CHARS, Math.floor(policy.effectiveContextWindow / 2));
    if (batchBudget < MIN_TRANSCRIPT_CHARS) return fallback;
    let summary = checkpoint?.summary;
    let started = false;
    for (const transcript of buildTranscripts(head, batchBudget)) {
        if (signal?.aborted) return fallback;
        if (!started) onCompacting?.();
        started = true;
        summary =
            (await generateCompactionSummary(transcript, summary, model, options.instructions, signal)) ?? undefined;
        if (!summary) {
            if (!signal?.aborted) noteCompactionFailure(sessionId);
            return fallback;
        }
    }
    if (!started || !summary || signal?.aborted) return fallback;

    const nextCheckpoint: CompactionCheckpoint = {
        summary,
        boundaryMessageId: plan.boundaryId,
        createdAt: Date.now(),
        summarizedCount: (checkpoint?.summarizedCount ?? 0) + head.length,
        tokensBefore: projected
    };
    const finalMicro = microcompactMessages(applyCheckpoint(messages, nextCheckpoint), {
        thresholdTokens: options.force ? 0 : policy.microcompactThreshold
    });
    const marker: CompactionMarker = {
        summarizedCount: head.length,
        keptCount: plan.keptCount,
        tokensBefore: projected,
        tokensAfter: estimateMessagesTokens(finalMicro.messages)
    };
    // 反应式重试比较上一份实际输入，避免用同一个 prompt 再撞一次超窗。
    if (retryBudget !== undefined && marker.tokensAfter >= retryBudget) return fallback;
    try {
        const committed = await store.updateCompaction(sessionId, nextCheckpoint, {
            expected: conv,
            ...(options.manual ? { manualMarker: marker } : {})
        });
        if (!committed) return { ...fallback, conflict: true };
    } catch (err) {
        noteCompactionFailure(sessionId);
        log.warn('压缩检查点落库失败，放弃本轮压缩', { sessionId, err });
        return fallback;
    }
    resetCompactionFailures(sessionId);
    log.info('已压缩上下文', {
        sessionId,
        tokensBefore: projected,
        tokensAfter: marker.tokensAfter,
        summarizedCount: head.length,
        keptCount: plan.keptCount,
        microcompactedCount: micro.clearedCount + finalMicro.clearedCount,
        microSavedTokens: micro.savedTokens + finalMicro.savedTokens,
        contextWindow: policy.contextWindow,
        compactThreshold: policy.compactThreshold,
        outputReserveTokens: policy.outputReserveTokens,
        reactive: options.force && !options.manual
    });
    return {
        modelInput: finalMicro.messages,
        marker,
        changed: true,
        usageScope: compactionUsageScope(model, nextCheckpoint)
    };
}
