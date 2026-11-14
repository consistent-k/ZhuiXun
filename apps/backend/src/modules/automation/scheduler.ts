import { createLogger } from '@/platform/logging/index';

import { recordAutomationAudit } from './audit';
import { dispatchAutomation, type AutomationDispatchDeps } from './dispatch';
import { automationEvents } from './events';
import { MISFIRE_GRACE_MS, type AutomationRecord, type AutomationStore } from './store';

const log = createLogger('AutomationScheduler');

/** setTimeout 延迟上限（约 24.8 天），超出则到点再重排，避免 32 位溢出立即触发。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** 同一时刻并发执行的任务数上限（单用户桌面，保守封顶）。 */
const MAX_CONCURRENT = 3;

/** 常驻调度器：进程内单 timer，到点认领到期任务并派发执行。 */
export interface AutomationScheduler {
    /** 启动：恢复残留在途任务 + 订阅定义变更 + 排下一次 timer。 */
    start(): Promise<void>;
    /** 停机：停 timer、退订（在途执行交由其自身 finally 收尾）。 */
    dispose(): Promise<void>;
    /** 定义变更后请求重排 timer（供 service 在 CRUD 后调用，或经 'changed' 事件触发）。 */
    requestReschedule(): void;
}

/**
 * 创建调度器。采用 deepseek-harness ScheduleRuntime 范式：全程最多一个 setTimeout 指向最近到期任务，
 * 而非轮询。到期 drive() 扫描 → single-flight 认领（store.claim）→ 后台 execute → 结算 → 重排。
 */
export function createScheduler(store: AutomationStore, dispatchDeps: AutomationDispatchDeps): AutomationScheduler {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let disposed = false;
    const running = new Set<string>();

    function clearTimer(): void {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    async function reschedule(): Promise<void> {
        if (disposed) return;
        clearTimer();
        const earliest = await store.earliestWake();
        if (earliest === undefined) return;
        const delay = Math.max(0, Math.min(earliest - Date.now(), MAX_TIMER_DELAY_MS));
        timer = setTimeout(() => void drive(), delay);
        timer.unref?.();
    }

    async function execute(record: AutomationRecord, runId: string): Promise<void> {
        try {
            await store.markRunning(record.id);
            const result = await dispatchAutomation(record, dispatchDeps);
            await store.settle(record.id, runId, result);
            recordAutomationAudit({
                event: 'settle',
                automationId: record.id,
                kind: record.schedule.kind,
                runId,
                outcome: result.outcome,
                steps: result.steps,
                error: result.error
            });
            automationEvents.emit({
                type: 'settle',
                automationId: record.id,
                title: record.title,
                runId,
                outcome: result.outcome,
                conversationId: result.conversationId,
                error: result.error
            });
        } catch (error) {
            // dispatchAutomation 已内部兜底，这里仅防御其它意外异常。
            const message = error instanceof Error ? error.message : String(error);
            await store.settle(record.id, runId, { outcome: 'failed', error: message }).catch(() => undefined);
            recordAutomationAudit({
                event: 'settle',
                automationId: record.id,
                runId,
                outcome: 'failed',
                error: message
            });
            automationEvents.emit({
                type: 'settle',
                automationId: record.id,
                title: record.title,
                runId,
                outcome: 'failed',
                error: message
            });
            log.error('任务执行异常', { id: record.id, err: error });
        } finally {
            running.delete(record.id);
            void reschedule();
        }
    }

    async function drive(): Promise<void> {
        if (disposed) return;
        try {
            const now = Date.now();
            const due = await store.findDue(now);
            for (const record of due) {
                if (running.size >= MAX_CONCURRENT) break;
                if (running.has(record.id)) continue;
                // 错过触发窗口（misfire）：仅对计划触发点（非退避 retryAt）判定，超宽限则跳过不跑（§11 决策）。
                if (
                    record.retryAt === undefined &&
                    record.nextRunAt !== undefined &&
                    now - record.nextRunAt > MISFIRE_GRACE_MS
                ) {
                    const skipped = await store.skipMisfire(record.id);
                    if (skipped) {
                        log.warn('任务错过触发窗口，已跳过', { id: record.id, scheduledAt: record.nextRunAt });
                        recordAutomationAudit({
                            event: 'misfire',
                            automationId: record.id,
                            kind: record.schedule.kind,
                            scheduledAt: record.nextRunAt,
                            latencyMs: now - record.nextRunAt,
                            missed: 1
                        });
                        automationEvents.emit({ type: 'changed', automationId: record.id });
                    }
                    continue;
                }
                const scheduledAt = record.retryAt ?? record.nextRunAt ?? now;
                const runId = `${record.id}:${scheduledAt}`;
                const claimed = await store.claim(record.id, runId, scheduledAt);
                if (!claimed) continue; // 认领失败（并发已被别处拿走）跳过
                running.add(record.id);
                recordAutomationAudit({
                    event: 'dispatch',
                    automationId: record.id,
                    kind: record.schedule.kind,
                    runId,
                    scheduledAt,
                    latencyMs: now - scheduledAt
                });
                automationEvents.emit({ type: 'dispatch', automationId: record.id, runId, scheduledAt });
                void execute(claimed, runId);
            }
        } catch (error) {
            log.error('调度扫描失败', { err: error });
        } finally {
            await reschedule();
        }
    }

    return {
        async start() {
            disposed = false;
            await store.recoverInterrupted().catch((err) => log.warn('恢复在途任务失败', { err }));
            // 仅对定义变更重排；dispatch/settle 事件由 execute 的 finally 自行重排。
            unsubscribe = automationEvents.subscribe((event) => {
                if (event.type === 'changed') void reschedule();
            });
            await reschedule();
            log.info('自动化任务调度器已启动');
        },
        async dispose() {
            disposed = true;
            clearTimer();
            unsubscribe?.();
            unsubscribe = null;
        },
        requestReschedule() {
            void reschedule();
        }
    };
}
