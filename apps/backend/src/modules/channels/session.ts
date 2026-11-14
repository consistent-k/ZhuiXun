/**
 * 渠道会话适配：把 IM 联系人映射到后端落盘会话（conversations/store），而非独立内存历史。
 * 每个 IM 联系人 = 一条稳定会话（id=`channel_<channelId>_<sanitizedUserId>`），持续追加、
 * 幂等 upsert；桌面端会话列表可见、可恢复。会话带 origin 供侧栏「渠道」分区两级分桶。
 */
import type { ModelMessage } from 'ai';

import { getConversationStore, type ConversationOrigin, type StoredMessage } from '@/modules/conversations';

/** 每个会话读取到模型的最大历史消息数（对齐 OA 的 50）。 */
const MAX_HISTORY_MESSAGES = 50;

/**
 * 生成稳定且合法的会话 id。conversations/store 的 id 只允许 [A-Za-z0-9_-]，
 * 因此把 IM userId 里的非法字符替换成 '-'；真实 channelId/imUserId 存在 origin 里，
 * 侧栏分桶用 origin 而非解析 id，故 id 只需稳定+合法。
 */
export function channelSessionId(channelId: string, imUserId: string): string {
    const safeUser = imUserId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
    return `channel_${channelId}_${safeUser}`.slice(0, 128);
}

/** 从落盘会话读取历史，转为 ModelMessage[]（只取 user/assistant 的纯文本，裁到上限）。 */
export async function loadHistory(sessionId: string): Promise<ModelMessage[]> {
    const conv = await getConversationStore().get(sessionId);
    if (!conv) return [];
    const msgs = conv.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }) as ModelMessage);
    return msgs.slice(-MAX_HISTORY_MESSAGES);
}

function textMessage(role: 'user' | 'assistant', text: string, suffix: string): StoredMessage {
    const now = Date.now();
    return {
        id: `${now}-${suffix}`,
        role,
        content: text,
        parts: [{ type: 'text', text }],
        timestamp: now
    };
}

function deriveTitle(text: string): string {
    const t = text.trim() || '渠道会话';
    return t.slice(0, 20) + (t.length > 20 ? '...' : '');
}

/** 追加一条用户消息（inbound 时先落，前端刷新能立刻看到会话与用户气泡）。 */
export async function appendUserMessage(sessionId: string, origin: ConversationOrigin, text: string): Promise<void> {
    const store = getConversationStore();
    const existing = await store.get(sessionId);
    const messages = [...(existing?.messages ?? []), textMessage('user', text, 'u')];
    await store.upsert(sessionId, {
        title: existing?.title || deriveTitle(text),
        projectId: existing?.projectId,
        origin: existing?.origin ?? origin,
        createdAt: existing?.createdAt || Date.now(),
        messages
    });
}

/** 追加一条 AI 回复（一轮结束后落，客户端已离开也不丢）。 */
export async function appendAssistantMessage(sessionId: string, text: string): Promise<void> {
    if (!text) return;
    const store = getConversationStore();
    const existing = await store.get(sessionId);
    if (!existing) return;
    const messages = [...existing.messages, textMessage('assistant', text, 'a')];
    await store.upsert(sessionId, {
        title: existing.title,
        projectId: existing.projectId,
        origin: existing.origin,
        createdAt: existing.createdAt,
        messages
    });
}
