/**
 * 单轮内（跨工具步）轻量上下文压缩——对标 AI SDK 文档 `agents/loop-control` 的
 * 「Context Management」：在 ToolLoopAgent 的 `prepareStep` 里用官方 `pruneMessages` 治理
 * 长工具链累积的历史推理与较早工具调用/结果，遏制单轮工具循环导致上下文超限。
 *
 * 与跨轮压缩的分工：此处零 LLM、确定性，只删轮内工具噪声（保留最近 2 条消息的工具内容）；
 * 跨轮的确定性工具产出清理见 microcompact，语义摘要 + 检查点 + 前端提示见 compactor。三者可叠加。
 *
 * 判阈与跨轮压缩共用 policy，使用同一套 CJK 感知估算，避免两套口径漂移。
 */
import { isDeepStrictEqual } from 'node:util';

import { pruneMessages, type ModelMessage } from 'ai';

import { getAppSettings } from '@/config/settings-store';
import type { ResolvedModel } from '@/config/types';
import { createLogger } from '@/platform/logging/index';

import { resolveCompactionPolicy } from './policy';
import { estimateMessagesTokens } from './token-estimate';

const log = createLogger('ContextCompaction');

/**
 * 构造 ToolLoopAgent 的 `prepareStep`：当某一步将发送的消息超过阈值时，用 pruneMessages
 * 删除历史推理与较早工具调用/结果。开关与阈值复用「设置 → 上下文压缩」；未开启或未超阈返回 undefined（走默认）。
 *
 * @param model 已解析模型（取 contextWindow 走统一策略；缺省用兜底常量）
 */
export function createStepCompactor(model: ResolvedModel) {
    return ({
        messages,
        steps
    }: {
        messages: ModelMessage[];
        steps: Array<{ usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }>;
    }): { messages: ModelMessage[] } | undefined => {
        try {
            const cfg = getAppSettings();
            if (!cfg.autoCompactEnabled) return undefined;
            const policy = resolveCompactionPolicy(model, cfg.autoCompactThreshold);
            // 轮内没有新的 provider usage 可读，只能估算；但上一步的 usage 是真实值，取两者较大值，
            // 避免系统提示词/技能目录等未计入消息文本的部分导致严重低估。
            const estimated = estimateMessagesTokens(messages);
            const lastStep = steps.at(-1);
            const lastUsage = lastStep?.usage;
            const lastTotal =
                lastUsage?.totalTokens ??
                (lastUsage && (lastUsage.inputTokens != null || lastUsage.outputTokens != null)
                    ? (lastUsage.inputTokens ?? 0) + (lastUsage.outputTokens ?? 0)
                    : 0);
            if (Math.max(estimated, lastTotal) <= policy.compactThreshold) {
                return undefined;
            }
            const pruned = pruneMessages({
                messages,
                reasoning: 'all',
                toolCalls: 'before-last-2-messages',
                emptyMessages: 'remove'
            });
            // SDK 会删掉同一条消息内的推理或工具 part，消息条数可能保持不变。
            if (isDeepStrictEqual(pruned, messages)) return undefined;
            log.info('轮内上下文压缩（pruneMessages）', { before: messages.length, after: pruned.length });
            return { messages: pruned };
        } catch (err) {
            log.warn('轮内压缩失败（忽略，使用全量）', { err });
            return undefined;
        }
    };
}
