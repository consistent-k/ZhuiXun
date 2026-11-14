/**
 * 会话运行事件（SSE `/api/session/events`）跨 HTTP 契约。
 *
 * P1/P2 的「后台完成唤醒 / 自驱回灌」会在无用户请求的情况下推进会话，前端必须能感知：
 * 侧栏列表要上浮、正打开的会话要重载消息、Goal 状态要更新、Job 完成要 toast。
 * 与 automation/channels 事件总线分开，避免把运行态塞进任务定义契约。
 */
import type { GoalView } from './goal';
import type { JobView } from './job';

/** 触发来源：真人输入 / 后台任务完成唤醒 / 自驱循环轮次。 */
export type SessionEventSource = 'user' | 'job' | 'goal';

/** 一轮结束时的结果（与 TurnPhase 终态对齐）。 */
export type SessionTurnOutcome = 'completed' | 'failed' | 'aborted';

/**
 * 投递被延后的原因：
 * - busy：会话正在跑，不能并发开新一轮；
 * - throttled：连续唤醒预算已用完，等真人输入重置。
 */
export type DeliveryDeferReason = 'busy' | 'throttled';

export type SessionEvent =
    | { type: 'turn-start'; sessionId: string; source: SessionEventSource }
    | {
          type: 'turn-end';
          sessionId: string;
          source: SessionEventSource;
          outcome: SessionTurnOutcome;
      }
    | {
          type: 'delivery';
          sessionId: string;
          source: SessionEventSource;
          /** true 表示本次投递没有立即开轮，已进入 inbox 等待。 */
          queued: boolean;
          reason?: DeliveryDeferReason;
          /** 累计连续唤醒次数（真人输入后归零），供排障。 */
          spentWakes: number;
      }
    | { type: 'job'; job: JobView }
    | { type: 'goal'; goal: GoalView };
