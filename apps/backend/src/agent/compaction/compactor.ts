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
import type { UIMessage } from 'ai';

import { getAppSettings } from '@/config/settings-store';
import type { ResolvedModel } from '@/config/types';
import type { getConversationStore } from '@/modules/conversations';
import type { CompactionCheckpoint } from '@/modules/conversations';
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

/** 送入摘要器的转写文本上限（控成本）；超出时保留最靠后的部分。 */
const MAX_TRANSCRIPT_CHARS = 24_000;
/** 连续失败计数的有效期：超过该时长未再失败则重新计数（避免一次故障永久停用压缩）。 */
const FAILURE_TTL_MS = 30 * 60_000;

interface LoosePart {
    type?: string;
    text?: string;
}

/** 抽取单条消息的可读文本（文本 part 拼接 + 工具/附件的简短标注），供摘要转写用。 */
function partsToText(message: UIMessage): string {
    const parts = (message.parts ?? []) as LoosePart[];
    let text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
    const toolCount = parts.filter((p) => typeof p.type === 'string' && p.type.startsWith('tool-')).length;
    const fileCount = parts.filter((p) => p.type === 'file').length;
    if (toolCount > 0) text += ` [工具调用x${toolCount}]`;
    if (fileCount > 0) text += ` [附件x${fileCount}]`;
    return text.trim();
}

/** 把一组消息转写为「角色：内容」的多行文本；超长时保留最靠后的片段。 */
function buildTranscript(messages: UIMessage[]): string {
    const lines = messages
        .map((m) => `${m.role === 'assistant' ? '助手' : '用户'}：${partsToText(m)}`)
        .filter((line) => line.length > 3);
    const transcript = lines.join('\n');
    return transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(-MAX_TRANSCRIPT_CHARS) : transcript;
}

/**
 * 读取最近一条 assistant 消息 metadata 里的使用量（上一轮实际用量，权威信号）；无则 undefined。
 *
 * 口径：优先 totalTokens；provider 未给 totalTokens 时用 input+output 兜底。
 * 注意：写入端（chat/service）必须存**最后一步**的 usage，而不是整轮所有 step 的 totalUsage，
 * 否则多步工具轮会把每步输入重复累加，导致判阈严重高估。
 */
function readPrevTotalTokens(messages: Array<{ role: string; metadata?: unknown }>): number | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue;
        const usage = (
            messages[i].metadata as
                { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } } | undefined
        )?.usage;
        if (!usage) return undefined;
        if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) return usage.totalTokens;
        const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        return total > 0 ? total : undefined;
    }
    return undefined;
}

/** 最后一条 assistant 消息的下标（用于估算「上一轮之后新增的消息」token）；无则 -1。 */
function findLastAssistantIndex(messages: UIMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return i;
    }
    return -1;
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
}

export interface ForceCompactParams extends CompactContextParams {
    /** 用户给出的摘要保留要点（如「保留方案调整的结论」） */
    instructions?: string;
}

interface CompactionRunOptions {
    /** 跳过阈值判断（反应式压缩：已经超窗，必须压）。 */
    force: boolean;
    /** 保留区目标预算占有效窗口的比例。 */
    keepRatio: number;
    /** 跳过连续失败熔断（反应式压缩是最后机会）。 */
    bypassFailureBreaker?: boolean;
    /** 不受「上下文压缩」开关影响（用户显式 /compact）。 */
    ignoreSetting?: boolean;
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
export async function reactiveCompactContext(params: CompactContextParams): Promise<CompactionOutcome> {
    return runCompaction(params, {
        force: true,
        keepRatio: REACTIVE_KEEP_RATIO,
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
        ignoreSetting: true,
        instructions: params.instructions
    });
}

async function runCompaction(params: CompactContextParams, options: CompactionRunOptions): Promise<CompactionOutcome> {
    const { store, sessionId, messages, model, onCompacting } = params;
    const cfg = getAppSettings();
    if (!cfg.autoCompactEnabled && !options.ignoreSetting) return { modelInput: messages, changed: false };

    const conv = await store.get(sessionId);
    const storedBoundaryIndex = conv?.compaction
        ? messages.findIndex((m) => m.id === conv.compaction?.boundaryMessageId)
        : -1;
    // 历史被回滚/裁剪后旧边界可能已不存在：此时忽略旧检查点（含旧摘要），避免把已摘要内容再并一次
    const checkpoint = storedBoundaryIndex > 0 ? conv?.compaction : undefined;
    const reconstructed = checkpoint ? applyCheckpoint(messages, checkpoint) : messages;
    const policy = resolveCompactionPolicy(model, cfg.autoCompactThreshold);

    // 第一级：确定性微压缩（零 LLM）。只改模型输入，不动磁盘/界面；省下的 token 参与后续判阈。
    const micro = microcompactMessages(reconstructed, {
        thresholdTokens: options.force ? 0 : policy.microcompactThreshold
    });

    // 投影本轮将喂入的 token：优先用上一轮实际用量（最后一步的 input+output）+ 其后新增消息估算；
    // 无用量时整体估算兜底。
    // 微压缩节省量只扣「本轮新增」的部分：上一轮的 input 里其实已经清过同一批旧工具产出，
    // 若把总节省量再从 prevTotal 里扣一次会低估上下文，导致该压不压。
    const prevTotal = readPrevTotalTokens(conv?.messages ?? []) ?? readPrevTotalTokens(messages);
    let projected: number;
    if (prevTotal !== undefined) {
        const lastAssistantIdx = findLastAssistantIndex(messages);
        let incrementalSaved = 0;
        if (micro.savedTokens > 0) {
            const previousInput = lastAssistantIdx >= 0 ? messages.slice(0, lastAssistantIdx + 1) : [];
            const previousMicro = microcompactMessages(
                checkpoint ? applyCheckpoint(previousInput, checkpoint) : previousInput,
                { thresholdTokens: 0 }
            );
            incrementalSaved = Math.max(0, micro.savedTokens - previousMicro.savedTokens);
        }
        projected = Math.max(
            0,
            prevTotal - incrementalSaved + estimateMessagesTokens(messages.slice(lastAssistantIdx + 1))
        );
    } else {
        projected = estimateMessagesTokens(micro.messages);
    }

    if (!options.force && projected < policy.compactThreshold) {
        return { modelInput: micro.messages, changed: micro.savedTokens > 0 };
    }

    if (!options.bypassFailureBreaker) {
        const failures = consecutiveFailures(sessionId);
        if (failures >= MAX_CONSECUTIVE_COMPACTION_FAILURES) {
            log.warn('连续压缩失败达到上限，本轮跳过自动压缩', { sessionId, failures });
            return { modelInput: micro.messages, changed: micro.savedTokens > 0 };
        }
    }

    // 需要压缩：规划新边界（基于全量 messages），保留预算按有效窗口（已扣输出预留）× 保留比例。
    const keepBudget = policy.effectiveContextWindow * options.keepRatio;
    const plan = planBoundary(messages, keepBudget);
    const prevBoundary = checkpoint ? storedBoundaryIndex : 0;
    // 无可压缩空间，或新边界未向前推进（无进展）：降级为微压缩后的输入
    if (!plan || plan.boundaryIndex <= prevBoundary) {
        return { modelInput: micro.messages, changed: micro.savedTokens > 0 };
    }

    // 待并入摘要的早期消息：仅取「上次边界 → 新边界」之间（之前的已折进 checkpoint.summary）
    const head = messages.slice(prevBoundary, plan.boundaryIndex);
    const transcript = buildTranscript(head);
    if (!transcript) return { modelInput: micro.messages, changed: micro.savedTokens > 0 };

    onCompacting?.(); // 确定要压缩、即将发起摘要调用：通知前端进入「压缩中」
    const summary = await generateCompactionSummary(transcript, checkpoint?.summary, model, options.instructions);
    if (!summary) {
        noteCompactionFailure(sessionId);
        log.warn('摘要生成失败，保留现有检查点', {
            sessionId,
            failures: consecutiveFailures(sessionId)
        });
        return { modelInput: micro.messages, changed: micro.savedTokens > 0 };
    }

    const nextCheckpoint: CompactionCheckpoint = {
        summary,
        boundaryMessageId: plan.boundaryId,
        createdAt: Date.now(),
        summarizedCount: (checkpoint?.summarizedCount ?? 0) + head.length,
        tokensBefore: projected
    };
    try {
        await store.updateCompaction(sessionId, nextCheckpoint);
    } catch (err) {
        // 检查点没落盘就不能只用摘要：否则下一轮无法重建，摘要白丢
        noteCompactionFailure(sessionId);
        log.warn('压缩检查点落库失败，放弃本轮压缩', { sessionId, err });
        return { modelInput: micro.messages, changed: micro.savedTokens > 0 };
    }
    resetCompactionFailures(sessionId);

    // 摘要后的输入再做一次微压缩：保留区里的旧工具产出同样可以清
    const finalMicro = microcompactMessages(applyCheckpoint(messages, nextCheckpoint), {
        thresholdTokens: options.force ? 0 : policy.microcompactThreshold
    });
    const marker: CompactionMarker = {
        summarizedCount: head.length,
        keptCount: plan.keptCount,
        tokensBefore: projected,
        tokensAfter: estimateMessagesTokens(finalMicro.messages)
    };
    log.info('已自动压缩上下文', {
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
        reactive: options.force
    });
    return { modelInput: finalMicro.messages, marker, changed: true };
}
