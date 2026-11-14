/**
 * 自驱循环（Goal）跨 HTTP 契约 DTO。
 *
 * Goal 是**进程本地**状态（不持久化）：重启后需人工重新 arm，避免自动跑飞。
 * 它只描述「某会话当前是否在按目标自动回灌」，与定时任务/后台任务的持久化记录无关。
 */

/** 自驱状态：armed 已武装待下一轮、running 正在跑本轮、blocked 触顶熔断、disarmed 已解除。 */
export type GoalStatus = 'armed' | 'running' | 'blocked' | 'disarmed';

/** 自驱循环视图。 */
export interface GoalView {
    sessionId: string;
    /** 目标描述（原样回灌进每轮 prompt）。 */
    goal: string;
    status: GoalStatus;
    /** 已开始的轮数。 */
    roundsStarted: number;
    /** 轮数上限（熔断阈值）。 */
    maxRounds: number;
    /** 最近一轮开始时间（epoch ms）。 */
    lastRoundAt?: number;
    /** 阻断/结束原因，供前端展示。 */
    note?: string;
}

/** 武装自驱循环请求（工具/HTTP 共用语义）。 */
export interface GoalArmRequest {
    sessionId: string;
    goal: string;
    /** 缺省 5，硬上限见后端 MAX_GOAL_ROUNDS。 */
    maxRounds?: number;
}
