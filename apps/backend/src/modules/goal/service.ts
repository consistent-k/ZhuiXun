import type { GoalView } from '@zhuixun/shared';

import { getAppSettings } from '@/config/settings-store';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('GoalService');

/** 轮数硬上限：即使请求传入更大值也截断，防止无限自驱。 */
export const MAX_GOAL_ROUNDS = 50;

/** 自驱轮次回灌 prompt：带上轮次与原始目标，要求基于会话进展继续推进。 */
function buildGoalRoundPrompt(goal: GoalRecord): string {
    return [
        `<goal_round round="${goal.roundsStarted}" max="${goal.maxRounds}">`,
        '你正在自驱执行同一个目标。请基于当前会话已有的进展继续推进下一步，不要重复已经完成的工作。',
        '如果目标已经达成，请在回复中使用 <goal_done> 标记并给出结论。',
        '',
        `目标：${goal.goal}`,
        '</goal_round>'
    ].join('\n');
}

/** 进程本地自驱状态（刻意不持久化：重启需人工重新 arm）。 */
export interface GoalRecord {
    sessionId: string;
    goal: string;
    status: GoalView['status'];
    roundsStarted: number;
    maxRounds: number;
    lastRoundAt?: number;
    note?: string;
}

/** 完成标记：模型在最后一轮回复里写入即视为目标达成。 */
const GOAL_DONE_MARK = '<goal_done>';

/** 一轮结束事件（由装配点从 chat 的 session 事件翻译后注入）。 */
export interface GoalTurnEndEvent {
    sessionId: string;
    source: 'user' | 'job' | 'goal';
    outcome: 'completed' | 'failed' | 'aborted';
}

/**
 * Goal 服务依赖（全部由 bootstrap 注入，模块自身不 import chat，避免 chat↔goal 循环引用）。
 */
export interface GoalServiceDeps {
    /** 订阅会话空闲（SessionRuntime.onIdle）。 */
    onIdle: (fn: (sessionId: string) => void) => () => void;
    /** 订阅轮次结束事件。 */
    onTurnEnd: (fn: (event: GoalTurnEndEvent) => void) => () => void;
    isBusy: (sessionId: string) => boolean;
    /** 投递一轮自驱 prompt；queued 表示因 busy 没开轮（自驱不占用唤醒节流预算）。 */
    deliver: (
        sessionId: string,
        text: string,
        source: 'goal',
        opts?: { bypassThrottle?: boolean }
    ) => 'started' | 'queued';
    /** 广播状态给前端（SSE）。 */
    emit: (goal: GoalView) => void;
    /** 读会话最后一条 assistant 文本（判定 <goal_done>）。 */
    readLastAssistantText: (sessionId: string) => Promise<string | undefined>;
}

/**
 * 自驱循环（Goal）：
 * - armed 后，每当会话空闲就回灌一轮 `<goal_round>` prompt；
 * - 每轮结束后检查 <goal_done>，达成或失败/触顶则 blocked；
 * - 唤醒节流由 SessionRuntime 统一处理（排队时回退本轮计数，等下一次空闲）。
 */
export class GoalService {
    private goals = new Map<string, GoalRecord>();
    /** 正在异步检查上一轮结果：期间禁止 idle 监听器抢跑下一轮。 */
    private checking = new Set<string>();
    private unsubscribers: Array<() => void> = [];

    constructor(private readonly deps: GoalServiceDeps) {}

    start(): void {
        if (this.unsubscribers.length > 0) return;
        this.unsubscribers = [
            this.deps.onIdle((sessionId) => void this.advance(sessionId)),
            this.deps.onTurnEnd((event) => this.handleTurnEnd(event))
        ];
    }

    dispose(): void {
        for (const off of this.unsubscribers) off();
        this.unsubscribers = [];
        this.goals.clear();
        this.checking.clear();
    }

    /** 武装（重新武装会从第 0 轮开始）。maxRounds 缺省取应用设置，硬上限 50。 */
    arm(sessionId: string, goal: string, maxRounds?: number): GoalView {
        const text = goal.trim();
        if (!text) throw new Error('目标不能为空');
        const configured = getAppSettings().goalMaxRounds;
        const limit = Math.min(MAX_GOAL_ROUNDS, Math.max(1, Math.round(maxRounds ?? configured)));
        const record: GoalRecord = {
            sessionId,
            goal: text,
            status: 'armed',
            roundsStarted: 0,
            maxRounds: limit,
            note: undefined
        };
        this.goals.set(sessionId, record);
        this.emit(record);
        log.info('GoalArmed', { sessionId, maxRounds: limit });
        // 当前已空闲则立刻开第一轮；忙则由本轮结束后的 idle 触发。
        if (!this.deps.isBusy(sessionId)) void this.advance(sessionId);
        return toGoalView(record);
    }

    disarm(sessionId: string): GoalView | null {
        const record = this.goals.get(sessionId);
        if (!record) return null;
        record.status = 'disarmed';
        record.note = '已手动解除自驱';
        this.emit(record);
        log.info('GoalDisarmed', { sessionId, roundsStarted: record.roundsStarted });
        return toGoalView(record);
    }

    get(sessionId: string): GoalView | null {
        const record = this.goals.get(sessionId);
        return record ? toGoalView(record) : null;
    }

    list(): GoalView[] {
        return [...this.goals.values()].map(toGoalView);
    }

    private handleTurnEnd(event: GoalTurnEndEvent): void {
        if (event.source !== 'goal') return;
        const record = this.goals.get(event.sessionId);
        if (!record) return;
        this.checking.add(event.sessionId);
        void (async () => {
            try {
                if (event.outcome !== 'completed') {
                    this.block(record, event.outcome === 'aborted' ? '本轮被中断' : '本轮执行失败');
                    return;
                }
                // onEnd 里 assistant 消息落库是异步的：稍等一拍再读，否则可能读到上一轮内容。
                await new Promise((resolve) => setTimeout(resolve, 100));
                const text = await this.deps.readLastAssistantText(event.sessionId).catch(() => undefined);
                if (text?.includes(GOAL_DONE_MARK)) {
                    this.block(record, '目标已完成');
                }
            } finally {
                this.checking.delete(event.sessionId);
                // 检查完若仍未 blocked，推进下一轮（idle 监听器在检查期间被 checking 挡住）。
                void this.advance(event.sessionId);
            }
        })();
    }

    private block(record: GoalRecord, note: string): void {
        record.status = 'blocked';
        record.note = note;
        this.emit(record);
        log.info('GoalBlocked', { sessionId: record.sessionId, note, roundsStarted: record.roundsStarted });
    }

    private async advance(sessionId: string): Promise<void> {
        const record = this.goals.get(sessionId);
        if (!record) return;
        if (record.status !== 'armed' && record.status !== 'running') return;
        if (this.checking.has(sessionId)) return;
        if (this.deps.isBusy(sessionId)) return;
        if (record.roundsStarted >= record.maxRounds) {
            this.block(record, `已达最大轮数 ${record.maxRounds}`);
            return;
        }
        record.roundsStarted += 1;
        record.status = 'running';
        record.lastRoundAt = Date.now();
        record.note = undefined;
        this.emit(record);

        const text = buildGoalRoundPrompt(record);
        // 自驱有自己的 maxRounds 熔断，不走 SessionRuntime 的「连续唤醒」预算，否则 3 轮就被掐断。
        const result = this.deps.deliver(sessionId, text, 'goal', { bypassThrottle: true });
        if (result === 'queued') {
            // 没真正开轮：回退计数，等唤醒预算/忙闲恢复后的下一次 idle 再试。
            record.roundsStarted = Math.max(0, record.roundsStarted - 1);
            record.status = 'armed';
            record.note = '唤醒节流中，等待下一次空闲';
            this.emit(record);
            log.info('GoalRoundDeferred', { sessionId, roundsStarted: record.roundsStarted });
        }
    }

    private emit(record: GoalRecord): void {
        this.deps.emit(toGoalView(record));
    }
}

function toGoalView(record: GoalRecord): GoalView {
    return {
        sessionId: record.sessionId,
        goal: record.goal,
        status: record.status,
        roundsStarted: record.roundsStarted,
        maxRounds: record.maxRounds,
        lastRoundAt: record.lastRoundAt,
        note: record.note
    };
}
