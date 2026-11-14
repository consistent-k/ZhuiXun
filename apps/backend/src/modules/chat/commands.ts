import type { CommandPartData } from '@zhuixun/shared';
import type { UIMessage } from 'ai';

import { expandCommandText, getCommandStore } from '@/modules/commands';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('Commands');

interface LoosePart {
    type?: string;
    text?: string;
    data?: unknown;
}

function commandData(parts: LoosePart[]): CommandPartData | undefined {
    const part = parts.find((p) => p.type === 'data-command');
    const data = part?.data as Partial<CommandPartData> | undefined;
    return data && typeof data.expanded === 'string' && typeof data.name === 'string'
        ? { name: data.name, args: typeof data.args === 'string' ? data.args : '', expanded: data.expanded }
        : undefined;
}

/** 用展开文本替换用户消息的 text part（附件等其它 part 保留），并去掉 data-command part。 */
function withExpandedText(message: UIMessage, expanded: string): UIMessage {
    const parts = (message.parts ?? []) as LoosePart[];
    const rest = parts.filter((p) => p.type !== 'text' && p.type !== 'data-command');
    return { ...message, parts: [{ type: 'text', text: expanded }, ...rest] as UIMessage['parts'] };
}

/**
 * 喂模型前展开 slash 命令（只改副本，落库仍用原始消息）：
 * - 用户消息带 `data-command` part：用其中的展开快照替换文本（命令文件后来被改不影响历史语义）；
 * - 兜底：最后一条用户消息以 `/name` 开头、无 data-command 且命中已有命令（如未来渠道侧）→ 后端自行展开；
 *   未命中按普通文本处理（用户可能真的想发 `/path/to/file`）。
 */
export async function expandCommandParts(messages: UIMessage[]): Promise<UIMessage[]> {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            lastUser = i;
            break;
        }
    }
    const out: UIMessage[] = [];
    for (const [index, message] of messages.entries()) {
        if (message.role !== 'user') {
            out.push(message);
            continue;
        }
        const parts = (message.parts ?? []) as LoosePart[];
        const data = commandData(parts);
        if (data) {
            out.push(withExpandedText(message, data.expanded));
            continue;
        }
        if (index === lastUser) {
            const text = parts
                .filter((p) => p.type === 'text')
                .map((p) => p.text ?? '')
                .join('');
            if (text.trimStart().startsWith('/')) {
                try {
                    const result = await expandCommandText(text, (name) => getCommandStore().bodyOf(name));
                    if (result.matched && result.expanded !== undefined) {
                        out.push(withExpandedText(message, result.expanded));
                        continue;
                    }
                } catch (err) {
                    log.warn('命令展开失败，按原文发送', { err });
                }
            }
        }
        out.push(message);
    }
    return out;
}
