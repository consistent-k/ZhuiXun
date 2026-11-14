import type { ApprovalMode, RetryNotice } from '@zhuixun/shared';
import { create } from 'zustand';

import { SUCCESS_CODE } from '@/constant/code';
import type { QuestionDraft } from '@/pages/home/components/AskQuestionCard/model';
import {
    clearConversationsApi,
    deleteConversationApi,
    fetchConversationApi,
    fetchConversationsApi,
    moveConversationApi,
    renameConversationApi,
    saveConversationApi,
    setConversationPersonaApi,
    type ConversationMeta
} from '@/services';
import type { Message } from '@/types/chat';

/** 新建/写入会话时的入参（含消息，用于乐观更新内存 + 写穿后端） */
interface ConversationInput {
    id: string;
    title: string;
    projectId?: string;
    personaId?: string;
    createdAt: number;
    updatedAt: number;
    messages: Message[];
}

type ApprovalSelection = { mode: Exclude<ApprovalMode, 'full-access'> } | { mode: 'full-access'; grant: string };

function revokeApprovalGrant(id: string, selection?: ApprovalSelection): void {
    if (selection?.mode === 'full-access') void window.zhuixun?.approval?.revoke(id).catch(console.error);
}

interface ChatState {
    approvalById: Record<string, ApprovalSelection | undefined>;
    setApproval: (id: string, selection: ApprovalSelection) => void;
    /** 会话列表元信息（不含 messages），启动时从后端 hydrate */
    conversations: ConversationMeta[];
    /** 按需拉取的单会话消息缓存 */
    messagesById: Record<string, Message[]>;
    /** 表单草稿仅驻留内存；会话切换及 Chat LRU 回收均不清理。 */
    questionDraftsByConversation: Record<string, Record<string, QuestionDraft>>;
    /** 当前会话 id，运行时态、由 URL 驱动，不持久化 */
    currentConversationId: string | null;
    /** 列表是否已从后端加载完成（作为路由重定向的门闩，防止未就绪时误判） */
    listLoaded: boolean;
    /** 各会话是否正在进行上下文自动压缩（运行时态，瞬态；用于聊天区展示「压缩中」） */
    compactingById: Record<string, boolean>;
    /** 各会话首输出前的自动重试状态（运行时态，瞬态；用于聊天区展示「正在重试」） */
    retryingById: Record<string, RetryNotice | undefined>;
    /** 草稿会话的风格选择；只在首条消息落库前使用 */
    draftPersonaById: Record<string, string | undefined>;
}

interface ChatActions {
    setQuestionDraft: (convId: string, key: string, draft: QuestionDraft) => void;
    clearQuestionDraft: (convId: string, key: string) => void;
    /** 回滚、重生成或恢复后清除已被移除的调用，避免草稿附着到新问题。 */
    pruneQuestionState: (convId: string, messages: Message[]) => void;
    /** 启动时从后端加载会话列表，幂等 */
    hydrate: () => Promise<void>;
    /** 强制从后端重拉会话列表（如项目删除后归属被复位，需刷新分桶）。保留已缓存的 messages。 */
    refreshList: () => Promise<void>;
    /** 按需加载单会话消息到缓存并返回；已缓存则直接返回 */
    loadMessages: (convId: string) => Promise<Message[]>;
    /** 强制从后端重拉单会话消息并覆盖缓存（渠道消息实时到达时用，绕过缓存） */
    reloadMessages: (convId: string) => Promise<Message[]>;
    /** 新增会话：乐观入内存 + 写穿后端（后台）。不自动激活，激活由路由承载 */
    addConversation: (conv: ConversationInput) => void;
    /** 用一轮结束后的最终消息整体替换会话历史 + 写穿后端（流式过程中不落库） */
    replaceMessages: (convId: string, messages: Message[]) => void;
    /** 用后端下发的 AI 标题更新内存会话标题（仅改内存镜像；后端已落库为权威真源，不再写穿） */
    applyGeneratedTitle: (convId: string, title: string) => void;
    /** 重命名会话（乐观改内存 + 轻量 PATCH 写穿后端；不传 messages） */
    renameConversation: (convId: string, title: string) => void;
    setCurrentConversation: (convId: string | null) => void;
    /** 设置某会话的「压缩中」状态（由 chatRegistry 的 onData 收到后端瞬态 data-compaction 时调用） */
    setCompacting: (convId: string, value: boolean) => void;
    /** 设置某会话的「正在重试」状态（由 chatRegistry 的 onData 收到后端瞬态 data-retry 时调用；undefined 清除） */
    setRetrying: (convId: string, notice: RetryNotice | undefined) => void;
    /** 移动会话到项目（乐观改内存 + 写穿后端；projectId 为 null 表示移出到未分组） */
    moveConversation: (convId: string, projectId: string | null) => void;
    /** 设置/清除已落库会话的风格覆盖（乐观改内存 + PATCH 后端） */
    setConversationPersona: (convId: string, personaId: string | null) => void;
    /** 设置/清除草稿会话的风格覆盖；首条消息落库后写入会话 */
    setDraftPersona: (convId: string, personaId: string | null) => void;
    deleteConversation: (convId: string) => void;
    /** 清空所有会话 */
    clearAll: () => void;
}

// hydrate 去重：React StrictMode 会重复触发挂载 effect，用共享 promise 保证只加载一次
let hydratePromise: Promise<void> | null = null;

export const useChatStore = create<ChatState & ChatActions>((set, get) => ({
    conversations: [],
    messagesById: {},
    questionDraftsByConversation: {},

    setQuestionDraft: (convId, key, draft) =>
        set((state) => ({
            questionDraftsByConversation: {
                ...state.questionDraftsByConversation,
                [convId]: { ...state.questionDraftsByConversation[convId], [key]: draft }
            }
        })),
    clearQuestionDraft: (convId, key) =>
        set((state) => ({
            questionDraftsByConversation: {
                ...state.questionDraftsByConversation,
                [convId]: Object.fromEntries(
                    Object.entries(state.questionDraftsByConversation[convId] ?? {}).filter(([id]) => id !== key)
                )
            }
        })),
    pruneQuestionState: (convId, messages) => {
        const alive = new Set(
            messages.flatMap((msg) =>
                msg.parts.flatMap((part) => ('toolCallId' in part ? [JSON.stringify([msg.id, part.toolCallId])] : []))
            )
        );
        set((state) => ({
            questionDraftsByConversation: {
                ...state.questionDraftsByConversation,
                [convId]: Object.fromEntries(
                    Object.entries(state.questionDraftsByConversation[convId] ?? {}).filter(([key]) => alive.has(key))
                )
            }
        }));
    },
    currentConversationId: null,
    listLoaded: false,
    compactingById: {},
    retryingById: {},
    approvalById: {},
    setApproval: (id, selection) => {
        if (selection.mode !== 'full-access') revokeApprovalGrant(id, get().approvalById[id]);
        set((state) => ({ approvalById: { ...state.approvalById, [id]: selection } }));
    },
    draftPersonaById: {},

    hydrate: () => {
        if (hydratePromise) return hydratePromise;
        hydratePromise = (async () => {
            try {
                const res = await fetchConversationsApi();
                if (res.code === SUCCESS_CODE && res.data) set({ conversations: res.data });
            } catch (err) {
                console.error('[chatStore] 加载会话列表失败:', err);
            } finally {
                // 无论成败都置位，避免路由重定向门闩永远卡在未就绪
                set({ listLoaded: true });
            }
        })();
        return hydratePromise;
    },

    refreshList: async () => {
        try {
            const res = await fetchConversationsApi();
            if (res.code === SUCCESS_CODE && res.data) set({ conversations: res.data });
        } catch (err) {
            console.error('[chatStore] 刷新会话列表失败:', err);
        }
    },

    loadMessages: async (convId) => {
        const cached = get().messagesById[convId];
        if (cached) return cached;
        // 未落库（新建草稿）/ 失效深链 / 索引有但文件缺失：一律按空白会话处理，
        // 缓存空数组、不抛错（hideError 不弹 toast）。激活逻辑不再据此重定向（见 pages/home）。
        let messages: Message[] = [];
        try {
            const res = await fetchConversationApi(convId, true);
            if (res.code === SUCCESS_CODE && res.data) messages = res.data.messages ?? [];
        } catch (err) {
            console.error('[chatStore] 加载会话消息失败，按空会话处理:', convId, err);
        }
        set((state) => ({ messagesById: { ...state.messagesById, [convId]: messages } }));
        return messages;
    },

    reloadMessages: async (convId) => {
        const res = await fetchConversationApi(convId, true);
        if (res.code !== SUCCESS_CODE || !res.data) throw new Error(res.message || '重载会话失败，请重试');
        const messages = res.data.messages ?? [];
        set((state) => ({ messagesById: { ...state.messagesById, [convId]: messages } }));
        get().pruneQuestionState(convId, messages);
        return messages;
    },

    addConversation: (conv) => {
        const meta: ConversationMeta = {
            id: conv.id,
            title: conv.title,
            projectId: conv.projectId,
            personaId: conv.personaId,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt
        };
        set((state) => ({
            conversations: [meta, ...state.conversations.filter((c) => c.id !== conv.id)],
            messagesById: { ...state.messagesById, [conv.id]: conv.messages },
            draftPersonaById: { ...state.draftPersonaById, [conv.id]: undefined }
        }));
        // 建会话写穿后端（后台，hideError：失败由 onFinish 的保存补建，不打扰用户）
        void saveConversationApi(
            conv.id,
            {
                title: conv.title,
                projectId: conv.projectId,
                personaId: conv.personaId,
                createdAt: conv.createdAt,
                messages: conv.messages
            },
            true
        );
    },

    replaceMessages: (convId, messages) => {
        const meta = get().conversations.find((c) => c.id === convId);
        set((state) => ({
            messagesById: { ...state.messagesById, [convId]: messages },
            conversations: state.conversations.map((c) => (c.id === convId ? { ...c, updatedAt: Date.now() } : c))
        }));
        if (!meta) return;
        // 写穿后端；失败由 request 拦截器统一 toast
        void saveConversationApi(convId, {
            title: meta.title,
            projectId: meta.projectId,
            personaId: meta.personaId,
            createdAt: meta.createdAt,
            messages
        });
        get().pruneQuestionState(convId, messages);
    },

    setCurrentConversation: (convId) => set({ currentConversationId: convId }),

    setCompacting: (convId, value) =>
        set((s) => {
            if (!!s.compactingById[convId] === value) return s;
            return { compactingById: { ...s.compactingById, [convId]: value } };
        }),

    setRetrying: (convId, notice) =>
        set((s) => {
            if (!notice && !s.retryingById[convId]) return s;
            return { retryingById: { ...s.retryingById, [convId]: notice } };
        }),

    applyGeneratedTitle: (convId, title) => {
        const next = title.trim();
        if (!next) return;
        set((state) => ({
            conversations: state.conversations.map((c) => (c.id === convId ? { ...c, title: next } : c))
        }));
    },

    renameConversation: (convId, title) => {
        const next = title.trim();
        if (!next) return;
        set((state) => ({
            conversations: state.conversations.map((c) =>
                c.id === convId ? { ...c, title: next, updatedAt: Date.now() } : c
            )
        }));
        // 轻量写穿：只改标题，失败由 request 拦截器统一 toast
        void renameConversationApi(convId, next);
    },

    moveConversation: (convId, projectId) => {
        set((state) => ({
            conversations: state.conversations.map((c) =>
                c.id === convId ? { ...c, projectId: projectId ?? undefined, updatedAt: Date.now() } : c
            )
        }));
        // 轻量写穿：只改归属，不重传 messages。失败由 request 拦截器统一 toast
        void moveConversationApi(convId, projectId);
    },

    setConversationPersona: (convId, personaId) => {
        set((state) => ({
            conversations: state.conversations.map((c) =>
                c.id === convId ? { ...c, personaId: personaId ?? undefined, updatedAt: Date.now() } : c
            )
        }));
        void setConversationPersonaApi(convId, personaId);
    },

    setDraftPersona: (convId, personaId) => {
        set((state) => ({
            draftPersonaById: { ...state.draftPersonaById, [convId]: personaId ?? undefined }
        }));
    },

    deleteConversation: (convId) => {
        revokeApprovalGrant(convId, get().approvalById[convId]);
        set((state) => {
            const { [convId]: _removed, ...rest } = state.messagesById;
            const { [convId]: _approval, ...approvalById } = state.approvalById;
            return {
                conversations: state.conversations.filter((c) => c.id !== convId),
                messagesById: rest,
                approvalById,
                questionDraftsByConversation: Object.fromEntries(
                    Object.entries(state.questionDraftsByConversation).filter(([id]) => id !== convId)
                ),
                draftPersonaById: Object.fromEntries(
                    Object.entries(state.draftPersonaById).filter(([id]) => id !== convId)
                ),
                currentConversationId: state.currentConversationId === convId ? null : state.currentConversationId
            };
        });
        void deleteConversationApi(convId);
    },

    clearAll: () => {
        for (const [id, selection] of Object.entries(get().approvalById)) revokeApprovalGrant(id, selection);
        set({
            conversations: [],
            approvalById: {},
            messagesById: {},
            draftPersonaById: {},
            questionDraftsByConversation: {},
            currentConversationId: null
        });
        void clearConversationsApi();
    }
}));
