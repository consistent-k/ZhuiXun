import { useEffect, useMemo, useState } from 'react';

import { chatRegistry } from '@/stores/chatRegistry';

/**
 * 订阅注册表的流式会话集合：返回当前处于生成中（submitted/streaming）的会话 id。
 * 供侧栏对每个会话项标注「生成中」。
 */
export function useStreamingConversations(): Set<string> {
    const [ids, setIds] = useState<Set<string>>(() => chatRegistry.getStreamingIds());
    useEffect(() => chatRegistry.subscribe(() => setIds(chatRegistry.getStreamingIds())), []);
    return ids;
}

/**
 * 除当前会话外仍在生成回复的会话数量，供页面顶部提示。
 * 与 `useChat` 解耦：只订阅注册表的流式集合，不参与 messages 的流式更新，
 * 因此可以把 `useChat` 的调用点留在 `ChatSession` 里。
 */
export function useBackgroundStreamCount(currentConversationId: string | null): number {
    const ids = useStreamingConversations();
    return useMemo(() => [...ids].filter((id) => id !== currentConversationId).length, [ids, currentConversationId]);
}
