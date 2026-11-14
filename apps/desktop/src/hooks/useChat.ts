import { useChat as useAiChat } from '@ai-sdk/react';
import type { CommandPartData } from '@zhuixun/shared';
import { useCallback, useMemo } from 'react';

import { resolveAttachmentUrl, type UploadedAttachment } from '@/services';
import { useChatStore, useProjectStore } from '@/stores';
import { chatRegistry } from '@/stores/chatRegistry';

/** 附件的 FileUIPart 形态（AI SDK：url 为可访问地址或 data URL）。 */
interface FileMessagePart {
    type: 'file';
    mediaType: string;
    filename?: string;
    url: string;
}

/** 仅附件（无文本）消息的标题/内容兜底标签。 */
function attachmentLabel(attachments: UploadedAttachment[]): string {
    const first = attachments[0];
    if (!first) return '';
    const prefix = first.mediaType.startsWith('image/') ? '[图片]' : '[文件]';
    return `${prefix} ${first.filename}`;
}

/**
 * 会话聊天 hook：消费注册表里该会话的常驻 `Chat` 实例（见 `stores/chatRegistry.ts`）。
 * 切换会话取回同一实例、切走的实例继续流式、切回实时接续；刷新恢复由注册表 `resumeActive` 承载。
 */
export function useChat() {
    const currentConversationId = useChatStore((s) => s.currentConversationId);
    // URL 恒带真实会话 id；'draft' 仅为根路径重定向前的瞬时兜底
    const chatId = currentConversationId || 'draft';
    // 当前会话是否正在进行上下文压缩（由 chatRegistry 收到后端瞬态状态时写入）
    const isCompacting = useChatStore((s) => !!s.compactingById[chatId]);
    // 首输出前限流/过载自动重试中（由 chatRegistry 收到后端瞬态 data-retry 时写入）
    const retrying = useChatStore((s) => s.retryingById[chatId]);

    // 常驻实例按会话 id 取回：同一会话跨渲染稳定，切换会话才换实例
    const chat = useMemo(() => chatRegistry.acquire(chatId), [chatId]);
    const ai = useAiChat({
        chat,
        // 一条 SSE 突发可能在一帧内产生几十次 write；节流到每 50ms（约 3 帧）一次提交。
        // 提交范围是本 hook 的调用方（ChatSession），消息列表经 Context 拿到新 messages；
        // 历史消息对象引用稳定，由 MessageRow 的 memo 拦住，只有流式那一条真正重渲染。
        throttle: 50
    });

    /**
     * 发送消息（可带图片/PDF 附件）。流式过程中不写 store，避免逐 chunk 更新引发全局重渲染。
     * `command`：slash 命令的展开快照，作为 `data-command` part 随消息落库（气泡仍显示原文，后端用展开文本喂模型）。
     */
    const send = useCallback(
        async (content: string, attachments: UploadedAttachment[] = [], command?: CommandPartData) => {
            const text = content.trim();
            if (!text && attachments.length === 0) return; // 空消息不发送
            const store = useChatStore.getState();
            const convId = store.currentConversationId;
            if (!convId) return; // URL 恒带会话 id，兜底：无身份不发送

            const title = text || attachmentLabel(attachments);
            // 首条消息才落库（懒建，避免未发消息就产生空会话）；会话 id 已由 URL 决定
            if (!store.conversations.some((c) => c.id === convId)) {
                store.addConversation({
                    id: convId,
                    title: title.slice(0, 20) + (title.length > 20 ? '...' : ''),
                    messages: [],
                    projectId: useProjectStore.getState().currentProjectId ?? undefined,
                    personaId: store.draftPersonaById[convId],
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                });
            }

            const instance = chatRegistry.acquire(convId);
            // 同会话已在流式则不重复发送（AI SDK 不支持并发流）
            if (instance.status === 'streaming' || instance.status === 'submitted') return;

            // 组装 parts：文本（若有）+ 各附件的 file part（url 为后端可访问的绝对地址，
            // 落库仍是该引用 URL；后端按会话读文件、展开为字节喂给模型，不把 base64 写进会话文件）
            const fileParts: FileMessagePart[] = attachments.map((a) => ({
                type: 'file',
                mediaType: a.mediaType,
                filename: a.filename,
                url: resolveAttachmentUrl(a.url)
            }));
            const commandParts = command ? [{ type: 'data-command' as const, data: command }] : [];
            const parts = [...(text ? [{ type: 'text' as const, text }] : []), ...fileParts, ...commandParts];

            const userMsgId = crypto.randomUUID();
            try {
                await instance.sendMessage({ id: userMsgId, parts });
            } catch {
                // 网络层异常（请求没发出）时 onFinish 不触发，这里兜底把 user 消息落库
                const latest = useChatStore.getState();
                if (latest.conversations.some((c) => c.id === convId)) {
                    latest.replaceMessages(convId, [
                        ...(latest.messagesById[convId] ?? []),
                        { id: userMsgId, role: 'user', content: title, parts, timestamp: Date.now() }
                    ]);
                }
            }
        },
        // 用注册表实例发送，不把每次渲染新建的 ai 对象放进依赖，保持 send 引用稳定
        []
    );

    /**
     * 重新生成最后一条回复（出错 / 中途断流后）。只重发、不改历史里的用户消息；
     * 生成中不重复触发（AI SDK 不支持并发流）。
     */
    const regenerate = useCallback(async () => {
        const convId = useChatStore.getState().currentConversationId;
        if (!convId) return;
        const instance = chatRegistry.acquire(convId);
        if (instance.status === 'streaming' || instance.status === 'submitted') return;
        instance.clearError();
        try {
            await instance.regenerate();
        } catch {
            /* 错误由 Chat 实例 error 状态承载并在聊天区展示 */
        }
    }, []);

    return {
        messages: ai.messages,
        send,
        regenerate,
        retrying,
        status: ai.status,
        error: ai.error,
        stop: () => chatRegistry.stopTurn(chat),
        isCompacting,
        addToolApprovalResponse: ai.addToolApprovalResponse,
        addToolOutput: ai.addToolOutput
    };
}
