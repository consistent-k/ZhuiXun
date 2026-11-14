import { randomUUID } from 'node:crypto';

import type { AutomationRunOutcome } from '@zhuixun/shared';

import type { AutomationRunFn } from '@/modules/chat/agents/runner';
import type { IConversationService, StoredMessage } from '@/modules/conversations';
import { createLogger } from '@/platform/logging/index';

import type { AutomationRecord } from './store';

const log = createLogger('AutomationDispatch');

/** 回灌框：对齐 deepseek-harness「scheduled message from the user」语义，原样带上任务 prompt。 */
const FRAMING = '这是一条来自【定时任务】的计划消息。请按下面的指令执行，并直接给出结果：';

/** 派发所需依赖（由装配点注入，automation 模块不直接取 chat/conversations 单例以便测试替换）。 */
export interface AutomationDispatchDeps {
    runAgent: AutomationRunFn;
    conversations: IConversationService;
}

export interface AutomationDispatchResult {
    outcome: AutomationRunOutcome;
    conversationId: string;
    error?: string;
    steps?: number;
}

function textMessage(role: 'user' | 'assistant', content: string): StoredMessage {
    return { id: randomUUID(), role, content, timestamp: Date.now(), parts: [{ type: 'text', text: content }] };
}

/**
 * 执行一次自动化任务：把 prompt 以计划消息框回灌进目标会话（绑定 sessionId 续原会话，否则新建），
 * 跑 headless agent 到完成，用户消息与结果都落库，供前端在会话里查看。返回结算所需的结果。
 *
 * 失败不抛：转成 outcome='failed' + error 返回，由调度器据此结算退避。
 */
export async function dispatchAutomation(
    record: AutomationRecord,
    deps: AutomationDispatchDeps
): Promise<AutomationDispatchResult> {
    const conversationId = record.sessionId ?? randomUUID();
    const framed = `${FRAMING}\n\n${record.prompt}`;

    // 先落用户侧消息：即便执行失败，会话里也能看到这次触发。
    try {
        await deps.conversations.appendMessages(conversationId, [textMessage('user', framed)], {
            title: record.title
        });
    } catch (error) {
        log.warn('写入触发消息失败（继续执行）', { id: record.id, err: error });
    }

    try {
        const result = await deps.runAgent(framed, { sessionId: conversationId });
        const text = result.text?.trim() || '（本次自动化任务没有产生文本输出）';
        await deps.conversations
            .appendMessages(conversationId, [textMessage('assistant', text)], { title: record.title })
            .catch((err) => log.warn('写入执行结果失败', { id: record.id, err }));
        log.info('自动化任务执行完成', { id: record.id, conversationId, steps: result.steps });
        return { outcome: 'succeeded', conversationId, steps: result.steps };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('自动化任务执行失败', { id: record.id, err: error });
        await deps.conversations
            .appendMessages(conversationId, [textMessage('assistant', `任务执行失败：${message}`)], {
                title: record.title
            })
            .catch(() => undefined);
        return { outcome: 'failed', conversationId, error: message };
    }
}
