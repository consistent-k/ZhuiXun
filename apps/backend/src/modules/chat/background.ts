import { randomUUID } from 'node:crypto';

import type { SessionEventSource, SessionTurnOutcome } from '@zhuixun/shared';
import type { UIMessage, UIMessageChunk } from 'ai';

import { getConversationStore, isValidConversationId, type StoredMessage } from '@/modules/conversations';
import type { SkillRegistry } from '@/modules/skills';
import { createLogger } from '@/platform/logging/index';

import { runChatTurn } from './service';
import { sessionRuntime } from './session-runtime';

const log = createLogger('BackgroundTurn');

/** 由 bootstrap 注入的注册表 getter（registry 是异步初始化的，不能在模块加载时取）。 */
let registryGetter: (() => SkillRegistry | undefined) | undefined;

/** 装配后台轮次能力：在 initializeServices 里传入 registry getter。 */
export function configureBackgroundTurns(getter: () => SkillRegistry | undefined): void {
    registryGetter = getter;
}

/** 落库消息 → UIMessage（parts 原样透传，缺失时用 content 兜底）。 */
function toUIMessages(messages: StoredMessage[]): UIMessage[] {
    return messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: (m.parts && m.parts.length > 0 ? m.parts : [{ type: 'text', text: m.content }]) as UIMessage['parts'],
        ...(m.metadata !== undefined ? { metadata: m.metadata } : {})
    }));
}

function userMessage(text: string): UIMessage {
    return {
        id: randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text }] as UIMessage['parts']
    };
}

/**
 * 在指定会话后台跑一轮完整交互式对话（与 `/api/chat/stream` 同一套 runChatTurn 编排，
 * 因此压缩、标题、落库、审批、hooks 全部生效），只是没有 HTTP 请求方：流由本函数自行消费。
 *
 * 负责会话忙闲登记（begin/end），runChatTurn 侧以 `manageSession: false` 跳过重复登记。
 * 失败只记录日志并落一条失败提示消息，不向上抛——调用方是定时/后台路径，没人 await。
 */
function runBackgroundTurn(
    req: { sessionId: string; text: string; source: SessionEventSource },
    registry: SkillRegistry
): void {
    void (async () => {
        let outcome: SessionTurnOutcome = 'completed';
        try {
            const store = getConversationStore();
            const conversation = isValidConversationId(req.sessionId) ? await store.get(req.sessionId) : null;
            const messages = [...toUIMessages(conversation?.messages ?? []), userMessage(req.text)];
            const handle = await runChatTurn(
                {
                    messages,
                    sessionId: req.sessionId,
                    origin: req.source,
                    manageSession: false
                },
                registry
            );
            // 必须把流消费完：onEnd 落库、记忆维护、Stop hooks 都挂在流结束上。
            for await (const _chunk of handle.stream as AsyncIterable<UIMessageChunk>) {
                // 无 HTTP 消费方，忽略帧内容，只驱动流程走完。
            }
            log.info('后台轮次完成', { sessionId: req.sessionId, source: req.source });
        } catch (error) {
            outcome = 'failed';
            const message = error instanceof Error ? error.message : String(error);
            log.error('后台轮次失败', { sessionId: req.sessionId, source: req.source, err: error });
            // 失败也要在会话里留痕，否则用户只看到消息石沉大海。
            await getConversationStore()
                .appendMessages(req.sessionId, [
                    {
                        id: randomUUID(),
                        role: 'assistant',
                        content: `自动执行失败：${message}`,
                        timestamp: Date.now(),
                        parts: [{ type: 'text', text: `自动执行失败：${message}` }]
                    }
                ])
                .catch(() => undefined);
        } finally {
            sessionRuntime.endTurn(req.sessionId, req.source, outcome);
        }
    })();
}

/**
 * 启动一个后台轮次（SessionRuntime 的 starter）。
 *
 * 同步完成忙闲登记：投递方（deliver）返回后紧接着又投递时不会再开第二轮。
 * 同步抛错（registry 未就绪）时由 SessionRuntime 回滚唤醒预算。
 */
export function startBackgroundTurn(req: { sessionId: string; text: string; source: SessionEventSource }): void {
    const registry = registryGetter?.();
    if (!registry) throw new Error('服务尚未就绪（技能注册表未初始化）');
    sessionRuntime.beginTurn(req.sessionId, req.source);
    runBackgroundTurn(req, registry);
}
