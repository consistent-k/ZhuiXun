import type { AskUserQuestionOutput } from '@zhuixun/shared';
import { App } from 'antd';
import { useCallback, useMemo, type ReactNode } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { useChat } from '@/hooks';
import { addPermissionApi } from '@/services';
import { useChatStore } from '@/stores';
import { chatRegistry } from '@/stores/chatRegistry';

import { collectPendingInteractions } from '../approval/pending';
import {
    ChatActionsContext,
    ChatMessagesContext,
    ChatRunContext,
    PendingApprovalContext,
    PendingQuestionContext,
    type ChatActions,
    type ChatRunState
} from '../chat-context';
import type { ApproveRemember } from '../ToolApprovalCard';

interface ChatSessionProps {
    /** 会话主体：由页面创建后作为 children 传入，引用稳定，不随 token 重渲染 */
    children: ReactNode;
}

/**
 * 会话容器：`useChat` 的唯一调用点。
 *
 * 为什么需要这一层：`useChat` 每次收到流式更新都会 setState 整个 snapshot（messages + status + error），
 * 调用它的组件必然随 token 重渲染，这一点无法规避。把调用点收进这个只分发 Context 的薄组件后：
 * - 它自己每 token 重渲染，但只重建 value 与 Provider，不渲染任何 DOM；
 * - `children` 是父级创建的稳定 element，整棵页面子树不跟着重渲染；
 * - 页面里只有消费 `ChatMessagesContext` 的组件（消息列表等）随 token 更新。
 *
 * 注意：同一个 Chat 实例不要在多处调用 `useChat` —— 每个调用点都会各自注册回调、各自 setState。
 */
export function ChatSession({ children }: ChatSessionProps) {
    const { message } = App.useApp();
    const ai = useChat();
    const { send, stop, regenerate, addToolApprovalResponse } = ai;
    const conversationId = useChatStore((state) => state.currentConversationId);

    const approveTool = useCallback(
        (approvalId: string, remember?: ApproveRemember) => {
            addToolApprovalResponse({ id: approvalId, approved: true });
            if (!remember) return;
            // 用户选择「记住」时，把命令/目录写进后端权限 store（本次批准已独立生效，写规则失败不阻断）
            void addPermissionApi({
                tool: remember.tool,
                command: remember.command,
                filePath: remember.filePath,
                scope: remember.scope,
                // 「本次会话」需带会话 id；草稿态为 null 时后端降级为仅本次放行
                sessionId: useChatStore.getState().currentConversationId ?? undefined
            }).then((res) => {
                if (res.code === SUCCESS_CODE && res.data?.rule) {
                    const noun = remember.tool === 'Write' ? '该目录' : '该命令';
                    message.success(remember.scope === 'permanent' ? `已永久记住${noun}` : `本次会话内${noun}将免确认`);
                } else {
                    message.info('未能记住，本次已放行');
                }
            });
        },
        [addToolApprovalResponse, message]
    );

    const denyTool = useCallback(
        (approvalId: string) => {
            addToolApprovalResponse({ id: approvalId, approved: false });
        },
        [addToolApprovalResponse]
    );

    // 回调捕获发起时的会话，await 之后不读取全局当前会话，避免切换后串答。
    const answerQuestion = useCallback(
        (toolCallId: string, output: AskUserQuestionOutput) => {
            if (!conversationId) return Promise.reject(new Error('尚未打开会话'));
            return chatRegistry.answerQuestion(conversationId, toolCallId, output);
        },
        [conversationId]
    );
    // 护栏截停后「继续」：发送一条普通用户消息，不引入新协议（技术方案 §4.2）
    const continueRun = useCallback(() => void send('继续完成上一个任务'), [send]);

    // 依赖项全是稳定引用（useChat 的 send/regenerate 是 useCallback，其余来自 Chat 实例），value 引用恒定
    const actions = useMemo<ChatActions>(
        () => ({
            send,
            stop: () => void stop(),
            regenerate,
            approveTool,
            denyTool,
            answerQuestion,
            continueRun
        }),
        [send, stop, regenerate, approveTool, denyTool, answerQuestion, continueRun]
    );

    // 只依赖原始值：ai 对象本身每 token 都是新引用，不能作为依赖
    // 待确认数量用于输入框发送门禁；它只在「出现/处理完」时变化，不会让 ChatArea 随 token 重渲染。
    const pendingInteractions = useMemo(() => collectPendingInteractions(ai.messages), [ai.messages]);
    const pendingInteractionCount = pendingInteractions.length;
    // 用拼接串做稳定 key：数组每 token 都是新引用，但内容不变时 Set 引用不换，工具卡的 memo 才有效
    const pendingApprovalKey = useMemo(
        () =>
            pendingInteractions
                .filter((item) => item.kind === 'approval' && item.approvalId)
                .map((item) => item.approvalId)
                .join('|'),
        [pendingInteractions]
    );
    const pendingApprovalIds = useMemo(
        () => new Set(pendingApprovalKey ? pendingApprovalKey.split('|') : []),
        [pendingApprovalKey]
    );
    const pendingQuestionKey =
        ai.status === 'ready'
            ? JSON.stringify(
                  pendingInteractions.filter((item) => item.kind === 'question').map((item) => item.toolCallId)
              )
            : '[]';
    const pendingQuestionIds = useMemo(() => new Set<string>(JSON.parse(pendingQuestionKey)), [pendingQuestionKey]);
    const run = useMemo<ChatRunState>(
        () => ({
            loading: ai.status === 'streaming' || ai.status === 'submitted',
            error: ai.error ?? null,
            isCompacting: ai.isCompacting,
            retrying: ai.retrying,
            pendingInteractionCount
        }),
        [ai.status, ai.error, ai.isCompacting, ai.retrying, pendingInteractionCount]
    );

    return (
        <ChatRunContext.Provider value={run}>
            <ChatActionsContext.Provider value={actions}>
                <ChatMessagesContext.Provider value={ai.messages}>
                    <PendingApprovalContext.Provider value={pendingApprovalIds}>
                        <PendingQuestionContext.Provider value={pendingQuestionIds}>
                            {children}
                        </PendingQuestionContext.Provider>
                    </PendingApprovalContext.Provider>
                </ChatMessagesContext.Provider>
            </ChatActionsContext.Provider>
        </ChatRunContext.Provider>
    );
}

export default ChatSession;
