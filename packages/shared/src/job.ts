/**
 * 后台任务（Job）跨 HTTP 契约 DTO。
 *
 * Job 与定时任务（Automation）共用「后台 headless 执行」的底层能力，但**状态轴独立**：
 * Automation 由时间驱动、有 nextRunAt/退避；Job 由用户/模型手动触发、一次性的长跑任务，
 * 完成后向 owner 会话投递唤醒通知。刻意不与 AutomationRecord 互相加字段。
 */

/** 任务状态：queued 等待并发位、running 执行中、succeeded/failed 终态、cancelled 用户取消。 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** 后台任务视图（前后端一字不差）。 */
export interface JobView {
    id: string;
    title: string;
    prompt: string;
    /** 归属会话：完成后结果落进该会话并唤醒它；缺省只落库不唤醒。 */
    ownerSessionId?: string;
    status: JobStatus;
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
    /** 成功时的最终文本（与落库的 assistant 消息一致）。 */
    result?: string;
    error?: string;
    steps?: number;
}

/** 创建后台任务请求。 */
export interface JobCreateRequest {
    title?: string;
    prompt: string;
    ownerSessionId?: string;
}
