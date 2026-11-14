/**
 * 构建注入给渠道包的 ChannelRuntime：把后端能力（落盘会话 / 可恢复流 / 事件总线 / 日志）
 * 装配成 @zhuixun/channels-core 约定的接口，让渠道 provider 包零后端依赖。
 */
import type { ChannelRuntime } from '@zhuixun/channels-core';

import { getResumableStreamStore } from '@/modules/chat';
import { createLogger } from '@/platform/logging/index';

import { channelEvents } from './events';
import { appendAssistantMessage, appendUserMessage, channelSessionId, loadHistory } from './session';

export function buildChannelRuntime(): ChannelRuntime {
    return {
        channelSessionId,
        loadHistory,
        // ChannelOrigin 与后端 ConversationOrigin 结构一致，直接透传
        appendUserMessage: (sessionId, origin, text) => appendUserMessage(sessionId, origin, text),
        appendAssistantMessage,
        recordStream: (sessionId, sse) => getResumableStreamStore().record(sessionId, sse),
        emitEvent: (event) => channelEvents.emit(event),
        createLogger: (scope) => createLogger(scope)
    };
}
