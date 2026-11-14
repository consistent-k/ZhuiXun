/**
 * 后端持有的 ChannelManager 单例（ChannelManager 类来自 @zhuixun/channels-core，纯逻辑）。
 * routes 与 registry 共用同一实例。刻意在后端持有单例，而非包内导出全局，避免 bundle 产生双份。
 */
import { ChannelManager } from '@zhuixun/channels-core';

import { createLogger } from '@/platform/logging/index';

export const channelManager = new ChannelManager(createLogger('ChannelManager'));
