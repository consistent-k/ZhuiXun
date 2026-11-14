/**
 * @zhuixun/channels-core — 渠道抽象层契约 + 管理器 + 通用消息管线。
 * 零后端依赖；后端能力经 ChannelRuntime 注入。渠道 provider 包只依赖本包。
 */
export type {
    Channel,
    ChannelStatus,
    ChannelStartOpts,
    ChannelMessageEvent,
    ChannelOrigin,
    RunAgentFn,
    MessageTransport,
    ChannelLogger,
    ChannelRuntime,
    ChannelContext,
    ProcessMessageParams
} from './types';
export { ChannelManager } from './manager';
export { processMessage, sleep } from './process-message';
