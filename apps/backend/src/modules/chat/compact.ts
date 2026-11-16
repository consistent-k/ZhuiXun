import type { CompactionMarker } from '@zhuixun/shared';
import type { UIMessage } from 'ai';

import { forceCompactContext } from '@/agent/compaction';
import { activeModel } from '@/config/model';
import { getConversationStore, isValidConversationId, type StoredMessage } from '@/modules/conversations';
import { createLogger } from '@/platform/logging/index';

import { getResumableStreamStore } from './stream-store';

const log = createLogger('ContextCompaction');

export class CompactError extends Error {
    constructor(
        readonly status: 400 | 404 | 409,
        message: string
    ) {
        super(message);
        this.name = 'CompactError';
    }
}

export interface CompactConversationResult {
    changed: boolean;
    marker?: CompactionMarker;
    /** 挂载标记的 assistant 消息 id（前端据此刷新该会话） */
    messageId?: string;
}

/** 落库消息 → UIMessage（只用于规划边界与转写摘要，不展开附件字节）。 */
function toUIMessages(messages: StoredMessage[]): UIMessage[] {
    return messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: (m.parts && m.parts.length > 0 ? m.parts : [{ type: 'text', text: m.content }]) as UIMessage['parts'],
        ...(m.metadata !== undefined ? { metadata: m.metadata } : {})
    }));
}

/**
 * 用户经 `/compact [说明]` 手动压缩会话上下文：
 * 跳过阈值与「上下文压缩」开关，写入检查点（下一轮对话自动使用），并把标记挂到最后一条 assistant 消息的
 * `metadata.manualCompaction`，前端在该消息之后渲染分隔条（与自动压缩的 `compaction` 分键，互不覆盖）。会话生成中返回 409，避免与本轮的自动压缩 / 落库交错。
 */
export async function compactConversation(id: string, instructions?: string): Promise<CompactConversationResult> {
    if (!isValidConversationId(id)) throw new CompactError(400, '非法会话 id');
    if (getResumableStreamStore().getActiveIds().includes(id)) {
        throw new CompactError(409, '会话正在生成回复，请稍后再压缩');
    }
    const store = getConversationStore();
    const conv = await store.get(id);
    if (!conv) throw new CompactError(404, '会话不存在');
    const model = activeModel();
    if (!model || !model.apiKey) {
        throw new CompactError(400, '未配置激活模型，请先在「设置 → 模型配置」中添加 provider 并选择激活模型');
    }

    const outcome = await forceCompactContext({
        store,
        sessionId: id,
        messages: toUIMessages(conv.messages),
        model,
        instructions,
        snapshot: conv
    });
    if (outcome.conflict) throw new CompactError(409, '会话历史已更新，请重新压缩');
    if (!outcome.marker) return { changed: false };

    const marker: CompactionMarker = outcome.marker;
    const target = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    log.info('已手动压缩上下文', { id, ...marker, withInstructions: !!instructions?.trim() });
    return { changed: true, marker, ...(target ? { messageId: target.id } : {}) };
}
