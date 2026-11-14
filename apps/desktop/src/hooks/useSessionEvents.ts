import { useEffect, useRef } from 'react';

import { subscribeSessionEvents } from '@/services';
import type { SessionEvent } from '@/types/session';

/**
 * 订阅会话运行事件（SSE）。断线自动重连；组件卸载时断开。
 * onEvent 用 ref 持有，避免每次渲染重连。与 useAutomationEvents 同构。
 */
export function useSessionEvents(onEvent: (event: SessionEvent) => void): void {
    const cbRef = useRef(onEvent);

    useEffect(() => {
        cbRef.current = onEvent;
    });

    useEffect(() => {
        let stopped = false;
        let unsubscribe = () => {};
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const connect = () => {
            if (stopped) return;
            unsubscribe = subscribeSessionEvents(
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
