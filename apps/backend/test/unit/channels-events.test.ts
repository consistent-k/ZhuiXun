import type { ChannelMessageEvent } from '@zhuixun/channels-core';
import { describe, expect, it, vi } from 'vitest';

import { channelEvents } from '@/modules/channels';

function event(type: ChannelMessageEvent['type']): ChannelMessageEvent {
    return {
        type,
        channelId: 'fake',
        channelName: '测试渠道',
        userId: 'contact',
        sessionId: 'channel_fake_contact',
        text: '测试消息',
        ts: 123
    };
}

describe('channelEvents', () => {
    it('向全部订阅者同步分发原始事件，取消订阅幂等且不影响其他订阅者', () => {
        const first = vi.fn();
        const second = vi.fn();
        const unsubscribeFirst = channelEvents.subscribe(first);
        const unsubscribeSecond = channelEvents.subscribe(second);
        try {
            const inbound = event('inbound');
            channelEvents.emit(inbound);
            expect(first).toHaveBeenCalledExactlyOnceWith(inbound);
            expect(second.mock.calls[0][0]).toBe(inbound);

            unsubscribeFirst();
            unsubscribeFirst();
            const reply = event('reply');
            const error = event('error');
            channelEvents.emit(reply);
            channelEvents.emit(error);
            expect(first).toHaveBeenCalledTimes(1);
            expect(second.mock.calls.map(([value]) => value)).toEqual([inbound, reply, error]);

            unsubscribeSecond();
            channelEvents.emit(event('inbound'));
            expect(second).toHaveBeenCalledTimes(3);
        } finally {
            unsubscribeFirst();
            unsubscribeSecond();
        }
    });

    it('支持超过十个页面同时订阅，并逐个清理', () => {
        const listeners = Array.from({ length: 15 }, () => vi.fn());
        const unsubscribe = listeners.map((listener) => channelEvents.subscribe(listener));
        try {
            const inbound = event('inbound');
            channelEvents.emit(inbound);
            for (const listener of listeners) expect(listener).toHaveBeenCalledExactlyOnceWith(inbound);
        } finally {
            for (const stop of unsubscribe) stop();
        }
        channelEvents.emit(event('reply'));
        for (const listener of listeners) expect(listener).toHaveBeenCalledTimes(1);
    });
});
