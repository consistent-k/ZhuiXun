import type { UIMessagePart, UIDataTypes, UITools } from 'ai';

export interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
    /** 完整消息结构（含工具调用 input/output），用于历史消息还原工具卡 */
    parts: UIMessagePart<UIDataTypes, UITools>[];
    /** UIMessage.metadata（如本轮最后一步 usage），历史会话还原 token 用量展示用 */
    metadata?: unknown;
}
