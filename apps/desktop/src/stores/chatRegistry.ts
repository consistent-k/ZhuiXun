import { Chat } from '@ai-sdk/react';
import type { AskUserQuestionOutput, RetryNotice, WorkspaceSummary } from '@zhuixun/shared';
import {
    DefaultChatTransport,
    isToolUIPart,
    lastAssistantMessageIsCompleteWithApprovalResponses,
    lastAssistantMessageIsCompleteWithToolCalls,
    type UIMessage
} from 'ai';

import { SUCCESS_CODE } from '@/constant/code';
import { collectPendingInteractions } from '@/pages/home/components/approval/pending';
import { parseQuestionInput, parseQuestionOutput } from '@/pages/home/components/AskQuestionCard/model';
import { fetchActiveStreamsApi } from '@/services';
import type { Message } from '@/types/chat';
import { API_BASE_URL, authHeaders, desktopApprovalBridge } from '@/utils/request';

import { useAppConfigStore } from './appConfigStore';
import { useChatStore } from './chatStore';
import { useProjectStore } from './projectStore';
import { useWorkspacePanelStore } from './workspacePanelStore';

/**
 * Chat 实例注册表：按会话 id 持有 AI SDK 的 `Chat` 实例，跨路由存活。
 *
 * 解决的根因：`useChat({ id })` 在 id 变化时会 `new Chat()` 重建实例、丢弃旧实例，
 * 导致切走的会话流不可见、切回无法接续。这里改为「每会话一个常驻实例」，由 `useChat`
 * 显式 `useAiChat({ chat })` 消费——切走的实例留在表里继续流式，切回命中同实例即实时接续。
 *
 * 同时承载「刷新可恢复」：刷新后经 `resumeActive()` 对后端仍在进行的会话触发 `resumeStream()`
 * （底层 GET 重连端点回放 SSE）。落库仍是持久化真源，本表只管运行时实例。
 */

function toUIMessages(messages: Message[] | undefined): UIMessage[] {
    return (messages ?? []).map((msg) => ({
        id: msg.id,
        role: msg.role,
        // 旧版纯文本记录没有 parts，进入 SDK 前统一补为文本 part。
        parts: msg.parts ?? [{ type: 'text', text: msg.content ?? '' }],
        // 还原 metadata（含本轮最后一步 usage），让历史会话切回后仍能展示 token 用量
        metadata: msg.metadata
    }));
}

/**
 * 一轮结束后转持久化格式（完整 parts，供历史还原工具卡片），丢弃无内容且无工具调用的消息。
 * 时间戳沿用 `previous` 里同 id 消息的值，只给本轮新消息取当前时刻——否则每轮落库都会把全部历史消息的
 * 时间刷成同一刻（后端 upsert 也会按首次落库收口，这里保证内存镜像一致）。
 */
function toStoreMessages(messages: UIMessage[], previous: Message[] | undefined): Message[] {
    const known = new Map((previous ?? []).map((m) => [m.id, m.timestamp]));
    const now = Date.now();
    return messages
        .map((msg) => {
            const text = msg.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('');
            const hasToolParts = msg.parts.some(isToolUIPart);
            return {
                id: msg.id,
                role: msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
                content: text,
                parts: msg.parts,
                // 保留 metadata（含本轮最后一步 usage），落库后历史会话仍可还原用量
                metadata: msg.metadata,
                timestamp: known.get(msg.id) ?? now,
                _hasContent: text.length > 0 || hasToolParts
            };
        })
        .filter((msg) => msg._hasContent)
        .map(({ _hasContent, ...msg }) => msg);
}

interface Entry {
    chat: Chat<UIMessage>;
    unsubscribeStatus: () => void;
}

/** 空闲实例上限；超出后从最久未访问起回收（不回收当前会话与流式中的实例） */
const MAX_INSTANCES = 20;

const instances = new Map<string, Entry>();
const lru: string[] = []; // 访问顺序，末尾最新
const activeIds = new Set<string>(); // 后端 /active 报告的进行中会话（刷新恢复用）
const resumedIds = new Set<string>(); // 已触发过 resumeStream 的会话（保证只重连一次）
const replayingIds = new Set<string>(); // SSE 回放只恢复显示，不据旧工具结果发起新一轮
const streamListeners = new Set<() => void>();

let initialized = false;
let notifyScheduled = false;
let resumeActivePromise: Promise<void> | null = null; // resumeActive 去重（StrictMode 双挂载）

/** 流式集合变化通知（去抖到微任务，避免在 React 渲染期同步 setState） */
function notifyStreamChange(): void {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
        notifyScheduled = false;
        for (const cb of streamListeners) cb();
    });
}

/** 首次使用时订阅会话列表：会话被删除/清空（present→absent）时释放实例并中止其流 */
function ensureInit(): void {
    if (initialized) return;
    initialized = true;
    useChatStore.subscribe((state, prev) => {
        if (state.conversations === prev.conversations) return;
        const alive = new Set(state.conversations.map((c) => c.id));
        for (const c of prev.conversations) {
            if (!alive.has(c.id) && instances.has(c.id)) dispose(c.id);
        }
    });
}

/** 每会话独立的 transport：body 绑定「自己的」会话上下文，而非全局当前会话 */
const turnRequests = new WeakMap<Chat<UIMessage>, string>();

function buildTransport(convId: string, onRequest: (id: string) => void): DefaultChatTransport<UIMessage> {
    return new DefaultChatTransport<UIMessage>({
        api: `${API_BASE_URL}/api/chat/stream`,
        headers: authHeaders(),
        body: () => {
            const chat = useChatStore.getState();
            const conv = chat.conversations.find((c) => c.id === convId);
            const personaId = conv?.personaId ?? chat.draftPersonaById[convId];
            const approval = chat.approvalById[convId];
            const requestId = crypto.randomUUID();
            onRequest(requestId);
            return {
                requestId,
                // 模型配置真源在后端 settings.json，请求体不再携带 modelConfig（后端用 getModelConfig 兜底）
                sessionId: convId,
                // 已落库会话取其项目；草稿取当前选中项目，让首轮就注入项目上下文
                projectId: conv?.projectId ?? useProjectStore.getState().currentProjectId ?? undefined,
                personaId,
                approvalMode: approval?.mode,
                approvalGrant: approval?.mode === 'full-access' && desktopApprovalBridge() ? approval.grant : undefined,
                // 默认对话加载模式来自后端 app 设置（progressive 时按需加载工具、省上下文）
                agentMode: useAppConfigStore.getState().defaultAgentMode
            };
        }
    });
}

/** 标题生成慢于回答时的兜底重取延时（ms）：留给后端完成一次性标题生成并落库，再重拉列表。 */
const TITLE_FALLBACK_DELAY_MS = 1500;

/** 从一轮消息里取后端下发的 AI 会话标题（挂在 assistant 消息 metadata.title），取不到返回 undefined。 */
function extractGeneratedTitle(messages: UIMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const meta = messages[i]?.metadata as { title?: unknown } | undefined;
        if (meta && typeof meta.title === 'string' && meta.title.trim()) return meta.title.trim();
    }
    return undefined;
}

/** 首轮判定：整轮仅一条用户消息（自动标题只在首轮生成）。 */
function isFirstTurn(messages: UIMessage[]): boolean {
    return messages.filter((m) => m.role === 'user').length === 1;
}

function createChat(convId: string): Chat<UIMessage> {
    const instance = new Chat<UIMessage>({
        id: convId,
        // 用落库历史 seed（切换会话激活前路由层已 loadMessages 填充缓存）
        messages: toUIMessages(useChatStore.getState().messagesById[convId]),
        transport: buildTransport(convId, (id) => turnRequests.set(instance, id)),
        // 工具批准后、客户端工具（askUserQuestion）回填后自动续跑
        sendAutomaticallyWhen: (opts) =>
            !replayingIds.has(convId) &&
            (lastAssistantMessageIsCompleteWithApprovalResponses(opts) ||
                lastAssistantMessageIsCompleteWithToolCalls(opts)),
        // 后端上下文压缩期间下发的瞬态状态（data-compaction）：驱动聊天区「压缩中」指示。
        // transient part 不进消息历史，只经此回调投递。phase=start 进入压缩中，done 结束。
        // data-retry：首输出前限流/过载/断连自动重试，phase=start 展示「正在重试」，done（新流已产出）收起。
        onData: (part) => {
            if (part.type === 'data-workspace-summary') {
                useWorkspacePanelStore.getState().receive(part.data as WorkspaceSummary);
            } else if (part.type === 'data-compaction') {
                const phase = (part.data as { phase?: string } | undefined)?.phase;
                useChatStore.getState().setCompacting(convId, phase === 'start');
            } else if (part.type === 'data-retry') {
                const notice = part.data as RetryNotice | undefined;
                useChatStore.getState().setRetrying(convId, notice?.phase === 'start' ? notice : undefined);
            }
        },
        // 每段流结束（含审批暂停、出错、中断）都落库：审批暂停也要持久化，否则刷新拿不到 approval-requested 态
        onFinish: ({ messages }) => {
            const store = useChatStore.getState();
            store.setCompacting(convId, false); // 一轮结束，清除「压缩中」兜底
            store.setRetrying(convId, undefined);
            if (!store.conversations.some((c) => c.id === convId)) return; // 会话已删除，无处落库
            // 自动标题：后端在首轮把 AI 标题挂到 assistant 消息 metadata 下发。
            // 先更新内存标题再整体回写消息，使写穿携带新标题（后端标题锁也会拒绝旧标题覆盖，双保险）。
            const title = extractGeneratedTitle(messages);
            if (title) store.applyGeneratedTitle(convId, title);
            store.replaceMessages(convId, toStoreMessages(messages, store.messagesById[convId]));
            void useWorkspacePanelStore.getState().load(convId);
            // 竞态兜底：标题生成慢于回答时本轮 metadata 不带标题，首轮后延时重取列表，拉取后端已落库标题。
            if (!title && isFirstTurn(messages)) {
                setTimeout(() => void useChatStore.getState().refreshList(), TITLE_FALLBACK_DELAY_MS);
            }
        }
    });
    return instance;
}

async function stopTurn(chat: Chat<UIMessage>): Promise<void> {
    const requestId = turnRequests.get(chat);
    try {
        if (requestId) {
            await fetch(`${API_BASE_URL}/api/chat/${encodeURIComponent(chat.id)}/cancel?requestId=${requestId}`, {
                method: 'POST',
                headers: authHeaders(),
                signal: AbortSignal.timeout(2000)
            });
        }
    } finally {
        await chat.stop();
    }
}

function touch(convId: string): void {
    const i = lru.indexOf(convId);
    if (i >= 0) lru.splice(i, 1);
    lru.push(convId);
}

/** 刷新后对后端仍在进行的会话触发一次 resumeStream；仅重连一次、草稿不重连 */
function maybeResume(convId: string): void {
    if (convId === 'draft' || !activeIds.has(convId) || resumedIds.has(convId)) return;
    const entry = instances.get(convId);
    if (!entry) return;
    resumedIds.add(convId);
    // SDK 在回放结束后也会检查自动续跑；重放已有答案不等于用户再次提交。
    replayingIds.add(convId);
    void entry.chat
        .resumeStream()
        .catch(() => {
            /* 无活动流(204)或重连失败：忽略，保持落库历史 */
        })
        .finally(() => replayingIds.delete(convId));
}

/** 超上限时从最久未访问起回收空闲实例（不动当前会话与流式中的实例） */
function evictIdle(): void {
    if (instances.size <= MAX_INSTANCES) return;
    const currentId = useChatStore.getState().currentConversationId;
    for (const convId of [...lru]) {
        if (instances.size <= MAX_INSTANCES) break;
        if (convId === currentId) continue;
        const status = instances.get(convId)?.chat.status;
        if (status === 'streaming' || status === 'submitted') continue;
        dispose(convId);
    }
}

/** 取（或懒建）某会话的常驻 Chat 实例 */
function acquire(convId: string): Chat<UIMessage> {
    ensureInit();
    let entry = instances.get(convId);
    if (!entry) {
        const chat = createChat(convId);
        const unsubscribeStatus = chat['~registerStatusCallback'](notifyStreamChange);
        entry = { chat, unsubscribeStatus };
        instances.set(convId, entry);
    }
    touch(convId);
    maybeResume(convId);
    evictIdle();
    return entry.chat;
}

/** 释放某会话实例：中止其流、解绑订阅、清出表 */
function dispose(convId: string): void {
    const entry = instances.get(convId);
    if (!entry) return;
    entry.unsubscribeStatus();
    void entry.chat.stop().catch(() => {
        /* 已结束/未在流式：忽略 */
    });
    instances.delete(convId);
    const i = lru.indexOf(convId);
    if (i >= 0) lru.splice(i, 1);
    activeIds.delete(convId);
    resumedIds.delete(convId);
    notifyStreamChange();
}

/** 当前处于生成中（submitted/streaming）的会话 id 集合 */
function getStreamingIds(): Set<string> {
    const ids = new Set<string>();
    for (const [convId, entry] of instances) {
        const status = entry.chat.status;
        if (status === 'streaming' || status === 'submitted') ids.add(convId);
    }
    return ids;
}

function subscribe(cb: () => void): () => void {
    streamListeners.add(cb);
    return () => {
        streamListeners.delete(cb);
    };
}

/** 刷新后调用：拉取后端进行中的会话，备好历史后重连其流（best-effort） */
async function resumeActive(): Promise<void> {
    // 去重：React StrictMode 会让挂载 effect 跑两次（hydrate 是共享 promise，但两次 .then
    // 各自触发一次 resumeActive），用共享 promise 保证 /api/chat/active 只拉一次
    if (resumeActivePromise) return resumeActivePromise;
    resumeActivePromise = (async () => {
        ensureInit();
        try {
            const res = await fetchActiveStreamsApi();
            if (res.code !== SUCCESS_CODE || !res.data?.ids?.length) return;
            for (const id of res.data.ids) {
                activeIds.add(id);
                // 先备好落库历史（含本轮 user 气泡）再重连，避免只显示 assistant
                await useChatStore.getState().loadMessages(id);
                acquire(id); // acquire 内部 maybeResume 会据 activeIds 触发重连
            }
        } catch {
            /* 拉取活动流失败：降级为不自动恢复 */
        }
    })();
    return resumeActivePromise;
}

/**
 * 渠道消息实时到达时，重载某会话并刷新其打开中的 Chat 视图。
 * 强制从后端重拉消息（含新到的 IM 用户消息与 AI 回复），并覆盖已存在实例的 messages，
 * 让正打开该会话的桌面端无需刷新即可看到更新。本地正在流式的会话不打断。
 */
async function reloadConversation(convId: string): Promise<void> {
    const entry = instances.get(convId);
    if (entry && (entry.chat.status === 'streaming' || entry.chat.status === 'submitted')) return;
    const fresh = await useChatStore.getState().reloadMessages(convId);
    if (entry) entry.chat.messages = toUIMessages(fresh);
}

/** 整组结果直接回填 SDK；持久化沿用会话链路，不把回填完成当成保存确认。 */
async function answerQuestion(convId: string, toolCallId: string, output: AskUserQuestionOutput): Promise<void> {
    const chat = instances.get(convId)?.chat;
    if (!chat || chat.status !== 'ready') throw new Error('请等待本轮结束后再回答');
    const pending = collectPendingInteractions(chat.messages).some(
        (item) => item.kind === 'question' && item.toolCallId === toolCallId
    );
    const message = chat.messages.find((msg) =>
        msg.parts.some((part) => isToolUIPart(part) && part.toolCallId === toolCallId)
    );
    const part = message?.parts.find((p) => isToolUIPart(p) && p.toolCallId === toolCallId);
    const input = part && 'input' in part ? parseQuestionInput(part.input) : null;
    const answer = input ? parseQuestionOutput(input, output) : null;
    if (!pending || !answer) throw new Error('该问题当前不可回答或答案不完整');
    await chat.addToolOutput({ tool: 'askUserQuestion', toolCallId, output: answer });
}

export const chatRegistry = {
    answerQuestion,
    stopTurn,
    acquire,
    dispose,
    getStreamingIds,
    subscribe,
    resumeActive,
    reloadConversation
};
