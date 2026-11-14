import { useEffect, useRef } from 'react';

import { subscribeChannelEvents, type ChannelMessageEvent } from '@/services';

/**
 * 订阅渠道消息事件（SSE）。断线自动重连；组件卸载时断开。
 * onEvent 用 ref 持有，避免每次渲染重连。
 */
export function useChannelEvents(onEvent: (event: ChannelMessageEvent) => void): void {
    const cbRef = useRef(onEvent);

    // 在 effect 中同步最新回调，避免在渲染期写 ref（react-hooks/refs）
    useEffect(() => {
        cbRef.current = onEvent;
    });

    useEffect(() => {
        let stopped = false;
        let unsubscribe = () => {};
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const connect = () => {
            if (stopped) return;
            unsubscribe = subscribeChannelEvents(
                (event) => cbRef.current(event),
                () => {
                    if (stopped) return;
                    retryTimer = setTimeout(connect, 3000);
                }
            );
        };
        connect();

        return () => {
            stopped = true;
            if (retryTimer) clearTimeout(retryTimer);
            unsubscribe();
        };
    }, []);
}
