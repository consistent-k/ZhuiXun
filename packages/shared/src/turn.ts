/**
 * 单轮对话结束时的停止原因（后端写入 assistant 消息 metadata.stopReason）。
 * - `max-steps`：达到单轮步数上限；
 * - `repeated-error`：同一工具连续同错达到熔断阈值；
 * - `repeated-call`：同一工具以相同参数连续调用且结果相同；
 * - `error`：模型/流出错结束。
 * 正常结束不写该字段。
 */
export type TurnStopReason = 'max-steps' | 'repeated-error' | 'repeated-call' | 'error';

/** 首输出前自动重试时下发的瞬态 data-retry 载荷（不进消息历史）。 */
export interface RetryNotice {
    phase: 'start' | 'done';
    /** 第几次重试（phase=start 时）。 */
    attempt?: number;
    /** 最大重试次数。 */
    max?: number;
    /** 本次退避等待毫秒数。 */
    delayMs?: number;
    /** 简短原因（状态码 / 错误类型），不含响应体。 */
    reason?: string;
}
