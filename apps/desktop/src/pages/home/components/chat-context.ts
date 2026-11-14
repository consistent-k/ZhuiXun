import type { AskUserQuestionOutput, CommandPartData, RetryNotice } from '@zhuixun/shared';
import type { UIMessage } from 'ai';
import { createContext, useContext } from 'react';

import type { UploadedAttachment } from '@/services';

import type { ApproveRemember } from './ToolApprovalCard';

/**
 * 会话级 Context（由 `ChatSession` 提供，向下只读）。
 *
 * 拆分依据是**变化频率**，不是职责：`useChat` 的 snapshot 每收到一次流式更新就会连同
 * messages / status / error 一起 setState，若塞进同一个 value，所有消费方都会随 token 重渲染。
 * 这里把每 token 变的 messages 与低频的运行态、恒定的动作集合分开，让标题栏、输入框等
 * 只订阅它们真正需要的那一份。
 */

/** 发送消息（含附件与 slash 命令展开快照），与 useChat().send 同签名 */
export type ChatSend = (
    content: string,
    attachments?: UploadedAttachment[],
    command?: CommandPartData
) => Promise<void>;

/**
 * 会话消息流：每收到一次节流后的流式更新就换引用。
 * 消费方只有消息列表与它下面派生用量 / 任务清单的组件；历史消息对象引用稳定，
 * 因此消息行用 memo + 引用比较即可跳过重渲染。
 */
export const ChatMessagesContext = createContext<UIMessage[]>([]);

export function useChatMessages(): UIMessage[] {
    return useContext(ChatMessagesContext);
}

/** 会话运行态：只在 status / error / 压缩 / 重试 / 待确认数量变化时换引用 */
export interface ChatRunState {
    /** 正在生成回复（streaming 或 submitted） */
    loading: boolean;
    error: Error | null;
    isCompacting: boolean;
    retrying?: RetryNotice;
    /** 当前轮待用户确认/回答的交互数量；只影响输入框发送门禁，不随 token 变化 */
    pendingInteractionCount: number;
}

export const ChatRunContext = createContext<ChatRunState>({
    loading: false,
    error: null,
    isCompacting: false,
    pendingInteractionCount: 0
});

export function useChatRun(): ChatRunState {
    return useContext(ChatRunContext);
}

/**
 * 会话动作集合：引用在整个挂载期内恒定。
 * 消息行、工具卡片都是 memo 的，动作一换引用就会让所有卡片重渲染，故这里只放稳定函数。
 */
export interface ChatActions {
    send: ChatSend;
    stop: () => void;
    regenerate: () => Promise<void>;
    /** 工具审批通过（remember 存在时同时写入权限规则） */
    approveTool: (approvalId: string, remember?: ApproveRemember) => void;
    /** 工具审批拒绝 */
    denyTool: (approvalId: string) => void;
    /** askUserQuestion 选项回填，回填后由 sendAutomaticallyWhen 自动续跑 */
    answerQuestion: (toolCallId: string, output: AskUserQuestionOutput) => Promise<void>;
    /** 护栏截停后继续上一个任务 */
    continueRun: () => void;
}

const noop = () => {};

export const ChatActionsContext = createContext<ChatActions>({
    send: async () => {},
    stop: noop,
    regenerate: async () => {},
    approveTool: noop,
    denyTool: noop,
    answerQuestion: async () => {},
    continueRun: noop
});

export function useChatActions(): ChatActions {
    return useContext(ChatActionsContext);
}

/**
 * 当前轮仍可操作的审批 id 集合。
 *
 * 历史轮次里的 approval-requested 只是轨迹，不能再给「去确认」按钮；
 * 用集合而不是数组，值只在待确认项变化时换引用，避免随 token 让工具卡重渲染。
 */
export const PendingApprovalContext = createContext<ReadonlySet<string>>(new Set());

export function usePendingApprovalIds(): ReadonlySet<string> {
    return useContext(PendingApprovalContext);
}

/** 当前可答集合按低频变化单独分发，避免历史题卡随 token 重渲染。 */
export const PendingQuestionContext = createContext<ReadonlySet<string>>(new Set());

export function usePendingQuestionIds(): ReadonlySet<string> {
    return useContext(PendingQuestionContext);
}
