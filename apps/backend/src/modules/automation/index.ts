/** automation 模块公开契约：定时任务的定义/台账持久化、业务服务、调度器与派发。模块外只从这里 import。 */
export type { AutomationListFilter } from './service';
export { AutomationService, getAutomationService } from './service';
export { createScheduler, type AutomationScheduler } from './scheduler';
export { dispatchAutomation, type AutomationDispatchDeps, type AutomationDispatchResult } from './dispatch';
export { flushAutomationAudit, recordAutomationAudit, type AutomationAuditEntry } from './audit';
export { automationEvents } from './events';
export { computeNextRunAt, isOneShot, parseCron, validateSchedule } from './cron';
export {
    AUTOMATION_CREATE_LIMIT,
    AutomationStore,
    createAutomationStore,
    getAutomationStore,
    MISFIRE_GRACE_MS,
    toRunView,
    toView,
    type AutomationRecord,
    type AutomationRunRecord,
    type AutomationSettleInput
} from './store';
