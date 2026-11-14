/**
 * 自动化任务（Automation）跨 HTTP 契约 DTO。
 *
 * 纯类型、零运行时：前端 `src/types` re-export、后端 domain 文件 `import type` 转发，两端一字不差。
 * 仅收录前后端本就该一致的视图/请求/事件；后端内部调度细节（retryAt、dispatchAttempts、
 * recentRuns 游标等）刻意不收，留在后端 domain，避免把调度内部结构泄露给前端。
 *
 * P0 聚焦「定时任务」：一次性（after/at）+ 周期（every/daily/weekly/cron）。
 */

/** 触发类型（判别联合的 tag）。 */
export type AutomationKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron';

/** 生命周期状态（业务语义轴）：active 可被调度；completed/failed 终态；paused 保留给手动暂停。 */
export type AutomationLifecycleStatus = 'active' | 'completed' | 'failed' | 'paused';

/** 派发状态（调度语义轴）：idle 空闲、claimed 已认领待跑、running 执行中、failed 上次派发失败待退避。 */
export type AutomationDispatchStatus = 'idle' | 'claimed' | 'running' | 'failed';

/** 单次运行结果。 */
export type AutomationRunOutcome = 'running' | 'succeeded' | 'failed' | 'stopped';

/**
 * 触发规则（判别联合）。时间统一用 epoch 毫秒或墙钟字段：
 * - after：相对当前 afterSeconds 秒后触发一次（一次性）。
 * - at：绝对 epoch ms 触发一次（一次性）。
 * - every：每隔 everySeconds 秒触发（周期）。
 * - daily：每天 time（"HH:mm"）触发（周期）。
 * - weekly：每周 weekdays（0=周日…6=周六）的 time 触发（周期）。
 * - cron：五段 Vixie cron 表达式（分 时 日 月 周），最小粒度 1 分钟（周期）。
 * timeZone 为 IANA 时区名，缺省按服务器本地时区；P0 仅 daily/weekly/cron 使用。
 */
export type AutomationSchedule =
    | { kind: 'after'; afterSeconds: number }
    | { kind: 'at'; at: number }
    | { kind: 'every'; everySeconds: number }
    | { kind: 'daily'; time: string; timeZone?: string }
    | { kind: 'weekly'; time: string; weekdays: number[]; timeZone?: string }
    | { kind: 'cron'; expression: string; timeZone?: string };

/** 任务展示视图（前后端一字不差）。 */
export interface AutomationView {
    id: string;
    title: string;
    prompt: string;
    schedule: AutomationSchedule;
    enabled: boolean;
    lifecycleStatus: AutomationLifecycleStatus;
    dispatchStatus: AutomationDispatchStatus;
    /** 绑定会话 id；缺省表示每次新建会话执行。 */
    sessionId?: string;
    /** 下次计划触发时间（epoch ms）；终态或已停用时可能缺省。 */
    nextRunAt?: number;
    /** 最近一次实际运行时间（epoch ms）。 */
    lastRunAt?: number;
    /** 最近一次失败原因，供管理页行内呈现。 */
    lastError?: string;
    createdAt: number;
    updatedAt: number;
}

/** 单次运行台账视图。 */
export interface AutomationRunView {
    runId: string;
    automationId: string;
    /** 计划触发时间（epoch ms）。 */
    scheduledAt: number;
    startedAt?: number;
    endedAt?: number;
    outcome: AutomationRunOutcome;
    /** 本次运行写入的会话 id，供前端跳转查看。 */
    conversationId?: string;
    error?: string;
    /** 本次 agent 循环步数，供排障。 */
    steps?: number;
}

/** 创建请求（schedule 的互斥选择器对齐判别联合）。 */
export interface AutomationCreateRequest {
    title: string;
    prompt: string;
    schedule: AutomationSchedule;
    sessionId?: string;
    /** 缺省 true。 */
    enabled?: boolean;
}

/** 编辑请求（部分字段，缺省不改）。 */
export interface AutomationUpdateRequest {
    title?: string;
    prompt?: string;
    schedule?: AutomationSchedule;
    enabled?: boolean;
}

/** SSE 实时事件：调度派发 / 结算 / 定义变更。 */
export type AutomationEvent =
    | { type: 'dispatch'; automationId: string; runId: string; scheduledAt: number }
    | {
          type: 'settle';
          automationId: string;
          /** 任务标题：前端未打开管理页时列表未 hydrate，通知文案要靠事件自带标题。 */
          title: string;
          runId: string;
          outcome: AutomationRunOutcome;
          conversationId?: string;
          error?: string;
      }
    | { type: 'changed'; automationId: string };
