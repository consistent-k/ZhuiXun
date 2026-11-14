/**
 * 自动化任务事件总线（进程内单例）。
 *
 * 调度器派发/结算、service CRUD → emit 事件 → routes/automation 的 SSE 端点订阅推给前端；
 * 调度器也订阅 'changed' 以在定义变更后重排 timer。单进程单线程，用 Node EventEmitter 即可。
 * 范式对齐 modules/channels/events.ts。
 */
import { EventEmitter } from 'node:events';

import type { AutomationEvent } from '@zhuixun/shared';

class AutomationEventBus {
    private emitter = new EventEmitter();

    constructor() {
        // SSE 订阅者数量随打开的前端页面波动，去掉默认 10 个上限告警。
        this.emitter.setMaxListeners(0);
    }

    emit(event: AutomationEvent): void {
        this.emitter.emit('event', event);
    }

    /** 订阅事件，返回取消订阅函数。 */
    subscribe(fn: (event: AutomationEvent) => void): () => void {
        this.emitter.on('event', fn);
        return () => this.emitter.off('event', fn);
    }
}

/** 全局单例。 */
export const automationEvents = new AutomationEventBus();
