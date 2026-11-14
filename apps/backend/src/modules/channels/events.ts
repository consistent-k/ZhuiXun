/**
 * 渠道消息事件总线（进程内单例）。
 * process-message 发事件 → routes/channels 的 SSE 端点订阅并推给前端，
 * 驱动侧栏「渠道」分区的列表刷新与未读提示。单进程单线程，用 Node EventEmitter 即可。
 */
import { EventEmitter } from 'node:events';

import type { ChannelMessageEvent } from '@zhuixun/channels-core';

class ChannelEventBus {
    private emitter = new EventEmitter();

    constructor() {
        // SSE 订阅者数量随打开的前端页面波动，去掉默认 10 个上限告警
        this.emitter.setMaxListeners(0);
    }

    emit(event: ChannelMessageEvent): void {
        this.emitter.emit('event', event);
    }

    /** 订阅事件，返回取消订阅函数 */
    subscribe(fn: (event: ChannelMessageEvent) => void): () => void {
        this.emitter.on('event', fn);
        return () => this.emitter.off('event', fn);
    }
}

/** 全局单例 */
export const channelEvents = new ChannelEventBus();
