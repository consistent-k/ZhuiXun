import type { DeliveryDeferReason, SessionEvent, SessionEventSource, SessionTurnOutcome } from '@zhuixun/shared';

import { getAppSettings } from '@/config/settings-store';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('SessionRuntime');

/** 一次待投递的后台消息（Job 完成通知 / Goal 轮次回灌）。 */
interface PendingDelivery {
    text: string;
    source: SessionEventSource;
}

/** 会话运行态（进程本地，不持久化）。 */
interface SessionState {
    /** 正在跑的轮数（>0 即 busy）。用计数而非布尔，避免异常路径漏减后永久卡死。 */
    busy: number;
    /** 因 busy / 节流而排队的投递。 */
    inbox: PendingDelivery[];
    /** 连续自动唤醒次数：真人输入归零（对齐 deepseek-harness tool-jobs 的 spentWakes）。 */
    spentWakes: number;
    lastHumanInputAt?: number;
}

/** 后台唤醒的启动器：由装配点注入（chat/background.ts），避免 runtime 反向依赖 runChatTurn。 */
export type SessionTurnStarter = (req: { sessionId: string; text: string; source: SessionEventSource }) => void;

/** 会话空闲监听器（Goal 自驱循环据此推进下一轮）。 */
export type SessionIdleListener = (sessionId: string) => void;

class SessionEventBus {
    private listeners = new Set<(event: SessionEvent) => void>();

    emit(event: SessionEvent): void {
        for (const fn of this.listeners) {
            try {
                fn(event);
            } catch (error) {
                log.warn('会话事件监听器抛错（忽略）', { err: error });
            }
        }
    }

    subscribe(fn: (event: SessionEvent) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}

/** 会话事件总线：SSE `/api/session/events` 与前端 store 订阅。 */
export const sessionEvents = new SessionEventBus();

/**
 * 会话运行态中心：忙闲登记、后台投递、唤醒节流、空闲通知。
 *
 * 关键不变量：
 * - `beginTurn` / `endTurn` 必须成对（后台路径由 background.ts 负责，HTTP 路径由 runChatTurn 负责）；
 * - 只有 `busy === 0` 且唤醒预算未耗尽时才立即开轮，否则进 inbox，等下一次空闲再投递；
 * - 真人输入（source=user）重置 `spentWakes`，避免自动循环饿死用户交互。
 */
export class SessionRuntime {
    private states = new Map<string, SessionState>();
    private starter: SessionTurnStarter | null = null;
    private idleListeners = new Set<SessionIdleListener>();

    private stateOf(sessionId: string): SessionState {
        let state = this.states.get(sessionId);
        if (!state) {
            state = { busy: 0, inbox: [], spentWakes: 0 };
            this.states.set(sessionId, state);
        }
        return state;
    }

    /** 注入后台启动器（bootstrap 装配时调用）。 */
    setStarter(starter: SessionTurnStarter): void {
        this.starter = starter;
    }

    /** 订阅「会话空闲」事件，返回取消订阅函数。 */
    onIdle(listener: SessionIdleListener): () => void {
        this.idleListeners.add(listener);
        return () => this.idleListeners.delete(listener);
    }

    isBusy(sessionId: string): boolean {
        return (this.states.get(sessionId)?.busy ?? 0) > 0;
    }

    /** 取连续唤醒次数（测试/排障）。 */
    spentWakesOf(sessionId: string): number {
        return this.states.get(sessionId)?.spentWakes ?? 0;
    }

    /** 取 inbox 长度（测试/排障）。 */
    inboxSizeOf(sessionId: string): number {
        return this.states.get(sessionId)?.inbox.length ?? 0;
    }

    /** 真人输入：重置唤醒预算。HTTP 路由在开始一轮前调用，确保用户主动说话后自动循环可以继续。 */
    noteHumanInput(sessionId: string): void {
        const state = this.stateOf(sessionId);
        state.spentWakes = 0;
        state.lastHumanInputAt = Date.now();
    }

    /** 登记一轮开始（busy++）。真人输入同时重置唤醒预算。 */
    beginTurn(sessionId: string, source: SessionEventSource): void {
        const state = this.stateOf(sessionId);
        state.busy += 1;
        if (source === 'user') {
            state.spentWakes = 0;
            state.lastHumanInputAt = Date.now();
        }
        sessionEvents.emit({ type: 'turn-start', sessionId, source });
    }

    /** 登记一轮结束（busy--）；归零时投递一条排队消息并通知空闲监听器（如 Goal）。 */
    endTurn(sessionId: string, source: SessionEventSource, outcome: SessionTurnOutcome): void {
        const state = this.stateOf(sessionId);
        state.busy = Math.max(0, state.busy - 1);
        sessionEvents.emit({ type: 'turn-end', sessionId, source, outcome });
        if (state.busy > 0) return;
        // 防止在流结束回调的调用栈里同步再开一轮（会与 SDK 的 onEnd 重入）。
        queueMicrotask(() => {
            this.drainOne(sessionId);
            for (const listener of this.idleListeners) {
                try {
                    listener(sessionId);
                } catch (error) {
                    log.warn('空闲监听器抛错（忽略）', { sessionId, err: error });
                }
            }
        });
    }

    /**
     * 投递一条后台消息（Job 完成 / Goal 轮次）。
     * 返回 'started' 表示已立即开轮，'queued' 表示因 busy 或节流进入 inbox。
     *
     * `bypassThrottle` 供 Goal 使用：自驱循环有自己的 maxRounds 熔断，不应再被
     * 「连续唤醒」预算提前掐断；且它不消耗预算，避免把后续 Job 完成通知一起饿死。
     */
    deliver(
        sessionId: string,
        text: string,
        source: SessionEventSource,
        opts?: { bypassThrottle?: boolean }
    ): 'started' | 'queued' {
        const state = this.stateOf(sessionId);
        const max = getAppSettings().maxConsecutiveWakes;
        if (state.busy > 0 || !this.starter) {
            return this.enqueue(sessionId, { text, source }, 'busy');
        }
        if (!opts?.bypassThrottle && state.spentWakes >= max) {
            log.info('连续唤醒达上限，改为排队注入', { sessionId, source, spentWakes: state.spentWakes, max });
            return this.enqueue(sessionId, { text, source }, 'throttled');
        }
        this.start(sessionId, { text, source }, opts?.bypassThrottle === true);
        return 'started';
    }

    private enqueue(sessionId: string, item: PendingDelivery, reason: DeliveryDeferReason): 'queued' {
        const state = this.stateOf(sessionId);
        state.inbox.push(item);
        sessionEvents.emit({
            type: 'delivery',
            sessionId,
            source: item.source,
            queued: true,
            reason,
            spentWakes: state.spentWakes
        });
        return 'queued';
    }

    /** 空闲时最多投递一条，避免一次完成后连续开多轮把用户淹没。 */
    private drainOne(sessionId: string): void {
        const state = this.states.get(sessionId);
        if (!state || state.busy > 0 || state.inbox.length === 0 || !this.starter) return;
        const max = getAppSettings().maxConsecutiveWakes;
        if (state.spentWakes >= max) {
            log.info('唤醒预算耗尽，排队消息继续等待真人输入', { sessionId, spentWakes: state.spentWakes });
            return;
        }
        const next = state.inbox.shift();
        if (next) this.start(sessionId, next);
    }

    private start(sessionId: string, item: PendingDelivery, bypassThrottle = false): void {
        const state = this.stateOf(sessionId);
        if (!bypassThrottle) state.spentWakes += 1;
        sessionEvents.emit({
            type: 'delivery',
            sessionId,
            source: item.source,
            queued: false,
            spentWakes: state.spentWakes
        });
        try {
            this.starter?.({ sessionId, text: item.text, source: item.source });
        } catch (error) {
            // 启动失败不应永久占用预算/忙闲：回滚预算并记录（busy 由调用方在 finally 里减）。
            if (!bypassThrottle) state.spentWakes = Math.max(0, state.spentWakes - 1);
            log.error('后台会话启动失败', { sessionId, source: item.source, err: error });
        }
    }

    /** 测试用：清空全部运行态。 */
    reset(): void {
        this.states.clear();
        this.starter = null;
        this.idleListeners.clear();
    }
}

/** 全局单例（进程内单用户桌面）。 */
export const sessionRuntime = new SessionRuntime();

/** 订阅会话事件（SSE / 测试）。 */
export function subscribeSessionEvents(fn: (event: SessionEvent) => void): () => void {
    return sessionEvents.subscribe(fn);
}
