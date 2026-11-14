/** channels 模块公开契约：IM 渠道注册、运行时与事件总线。 */
export { channelManager } from './channel-manager';
export { channelEvents } from './events';
export { buildChannelRuntime } from './runtime';
export { registerChannels } from './registry';
export { appendAssistantMessage, appendUserMessage, channelSessionId, loadHistory } from './session';
