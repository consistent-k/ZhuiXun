/**
 * Channel 抽象层契约 — 供渠道 provider 包与宿主（后端）共用。
 * 零后端依赖：会话落盘 / 可恢复流 / 日志 / 事件总线等后端能力全部经 ChannelRuntime 注入。
 */
import type { ModelMessage, UIMessageChunk } from 'ai';

export type ChannelStatus = 'idle' | 'starting' | 'running' | 'error';

/** 会话来源标记：渠道会话带 channelId + IM 用户 id，供侧栏「渠道」分区分桶。 */
export interface ChannelOrigin {
    kind: 'channel';
    channelId: string;
    channelName?: string;
    imUserId: string;
}

/** 消息事件：既回传宿主做审计/落盘，也经事件总线推 SSE 给前端。 */
export type ChannelMessageEvent = {
    type: 'inbound' | 'reply' | 'error';
    channelId: string;
    channelName: string;
    userId: string;
    sessionId: string;
    text: string;
    ts: number;
};

export type ChannelStartOpts = {
    abortSignal: AbortSignal;
};

/** 渠道契约：provider 实现，ChannelManager 统一注册/启停。 */
export interface Channel {
    readonly id: string;
    readonly name: string;
    status: ChannelStatus;
    start(opts: ChannelStartOpts): Promise<void>;
    stop(): Promise<void>;
    isConfigured(): boolean;
    getStatusInfo(): string[];
    logout?(): Promise<string[]>;
    /** 表单绑定（Telegram: {token}）。 */
    bind?(payload: Record<string, string>): Promise<string[]>;
    /** 扫码绑定（微信）：发起扫码，返回二维码信息。 */
    startQrLogin?(): Promise<{ sessionKey: string; qrcodeUrl?: string; message: string }>;
    /** 扫码绑定（微信）：轮询扫码结果。 */
    pollQrLogin?(sessionKey: string): Promise<{ connected: boolean; accountId?: string; message: string }>;
}

/** 由宿主注入的 AI 调用函数（渠道受限工具集，见后端 createChannelRunAgent）。 */
export type RunAgentFn = (
    messages: ModelMessage[],
    opts: { sessionId: string; abortSignal?: AbortSignal }
) => Promise<{ toUIMessageStream: () => AsyncIterable<UIMessageChunk> }>;

/** 消息传输接口 — provider 实现，供通用 processMessage 使用。 */
export interface MessageTransport {
    sendText(userId: string, text: string): Promise<void>;
    sendNotification(userId: string, text: string): void;
    startTyping(userId: string, signal?: AbortSignal): Promise<() => void> | (() => void);
}

/** processMessage 入参（provider 收到一条 inbound 后构造）。 */
export interface ProcessMessageParams {
    channelId: string;
    channelName: string;
    userId: string;
    text: string;
    transport: MessageTransport;
    abortSignal?: AbortSignal;
    /** 对回复文本做后处理（如微信 markdown 过滤），默认 identity。 */
    filterReply?: (text: string) => string;
}

/** 简易日志接口（由宿主注入实现，包内不直接依赖后端 logging）。 */
export interface ChannelLogger {
    info(message: string, extra?: unknown): void;
    warn(message: string, extra?: unknown): void;
    error(message: string, extra?: unknown): void;
}

/**
 * 后端能力注入：把落盘会话 / 可恢复流 / 事件总线 / 日志从契约里解耦出去，
 * 让渠道包零后端依赖。宿主在注册渠道时构造并注入（见后端 buildChannelRuntime）。
 */
export interface ChannelRuntime {
    /** IM 联系人 → 稳定会话 id。 */
    channelSessionId(channelId: string, imUserId: string): string;
    /** 读取会话历史（转 ModelMessage[]）。 */
    loadHistory(sessionId: string): Promise<ModelMessage[]>;
    /** 追加用户消息到落盘会话。 */
    appendUserMessage(sessionId: string, origin: ChannelOrigin, text: string): Promise<void>;
    /** 追加 AI 回复到落盘会话。 */
    appendAssistantMessage(sessionId: string, text: string): Promise<void>;
    /** 旁路录入可恢复流（前端逐字回放）。 */
    recordStream(sessionId: string, sse: ReadableStream<string>): void;
    /** 发渠道消息事件（宿主推 SSE 给前端）。 */
    emitEvent(event: ChannelMessageEvent): void;
    /** 创建带作用域的 logger。 */
    createLogger(scope: string): ChannelLogger;
}

/**
 * 渠道运行上下文：注册时注入给 provider。
 * 除后端能力（runtime）与 AI 调用（runAgent）外，还注入 processMessage / sleep——
 * 这样第三方渠道插件在运行时**无需 import 本包**（打包态无 node_modules 也能跑），
 * 只用 ctx 即可完成全部工作，本包仅作 `import type` 的编译期依赖。
 */
export interface ChannelContext {
    runAgent: RunAgentFn;
    runtime: ChannelRuntime;
    processMessage: (params: ProcessMessageParams, ctx: ChannelContext) => Promise<void>;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}
