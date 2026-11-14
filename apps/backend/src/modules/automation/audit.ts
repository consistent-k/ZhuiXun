import fsp from 'node:fs/promises';

import { paths } from '@/config/paths';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('AutomationAudit');

/** 审计事件类型（§9 埋点点位）。 */
export type AutomationAuditEvent =
    'create' | 'update' | 'delete' | 'enable' | 'disable' | 'dispatch' | 'settle' | 'misfire' | 'recover';

/** 一条审计记录。只落调度元数据，不落 prompt 正文（可能含敏感信息）。 */
export interface AutomationAuditEntry {
    event: AutomationAuditEvent;
    automationId: string;
    /** 创建/编辑来源：管理页或会话工具。 */
    source?: 'ui' | 'tool';
    kind?: string;
    runId?: string;
    scheduledAt?: number;
    /** 派发延迟（实际派发 - 计划时间）。 */
    latencyMs?: number;
    outcome?: string;
    steps?: number;
    /** 错过窗口数（misfire）。 */
    missed?: number;
    error?: string;
}

/** 串行写队列：避免并发 append 交错；失败只告警，不影响调度主流程。 */
let auditChain: Promise<unknown> = Promise.resolve();

/** 追加一行 JSONL 审计。 */
export function recordAutomationAudit(entry: AutomationAuditEntry): void {
    const record = {
        ts: new Date().toISOString(),
        ...entry,
        ...(entry.error ? { error: entry.error.slice(0, 300) } : {})
    };
    const line = `${JSON.stringify(record)}\n`;
    auditChain = auditChain
        .then(async () => {
            await fsp.mkdir(paths.auditDir(), { recursive: true });
            await fsp.appendFile(paths.automationAuditFile(), line, 'utf8');
        })
        .catch((error: unknown) => {
            log.warn('自动化任务审计写入失败', { err: error });
        });
}

/** 测试用：等待审计队列落盘。 */
export function flushAutomationAudit(): Promise<void> {
    return auditChain.then(() => undefined);
}
