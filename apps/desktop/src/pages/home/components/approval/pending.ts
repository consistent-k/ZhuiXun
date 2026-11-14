import { getToolName, isToolUIPart, type UIMessage } from 'ai';

import { ASK_USER_QUESTION_TOOL, type AnyToolPart } from '../activity/model';

/** 当前轮里需要用户处理的阻塞交互 */
export interface PendingInteraction {
    kind: 'approval' | 'question';
    /** 稳定 key：审批用 approvalId，提问用 toolCallId */
    key: string;
    messageId: string;
    toolCallId: string;
    toolName: string;
    part: AnyToolPart;
    approvalId?: string;
}

/**
 * 只收集「最后一条 user 消息之后」的待确认项。
 *
 * 已处理或历史轮次里的 approval-requested 不再可操作：它们只是历史轨迹，
 * 继续给按钮会让人误以为能给上一轮补批。审批优先于提问，同类保持消息内顺序。
 */
export function collectPendingInteractions(
    messages: readonly Pick<UIMessage, 'id' | 'role' | 'parts'>[]
): PendingInteraction[] {
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') {
            start = i + 1;
            break;
        }
    }

    const items: PendingInteraction[] = [];
    for (let i = start; i < messages.length; i += 1) {
        const message = messages[i];
        if (message.role !== 'assistant') continue;
        for (const part of message.parts) {
            if (!isToolUIPart(part)) continue;
            const toolName = getToolName(part);
            if (part.state === 'approval-requested' && !part.approval.isAutomatic) {
                items.push({
                    kind: 'approval',
                    key: `approval:${part.approval.id}`,
                    messageId: message.id,
                    toolCallId: part.toolCallId,
                    toolName,
                    part,
                    approvalId: part.approval.id
                });
                continue;
            }
            if (toolName === ASK_USER_QUESTION_TOOL && part.state === 'input-available') {
                items.push({
                    kind: 'question',
                    key: `question:${part.toolCallId}`,
                    messageId: message.id,
                    toolCallId: part.toolCallId,
                    toolName,
                    part
                });
            }
        }
    }

    return items.sort((left, right) => {
        if (left.kind === right.kind) return 0;
        return left.kind === 'approval' ? -1 : 1;
    });
}
