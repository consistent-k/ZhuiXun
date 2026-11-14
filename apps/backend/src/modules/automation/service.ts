import type {
    AutomationCreateRequest,
    AutomationRunView,
    AutomationUpdateRequest,
    AutomationView
} from '@zhuixun/shared';

import { recordAutomationAudit } from './audit';
import { automationEvents } from './events';
import { getAutomationStore, toRunView, toView, type AutomationStore } from './store';

/** 列表筛选：启用 / 停用（inactive）/ 全部。 */
export type AutomationListFilter = 'enabled' | 'inactive' | 'all';

/**
 * 自动化任务业务服务：路由与 agent 工具的统一入口。包裹 store 做视图映射，并在每次写操作后
 * emit 'changed' 事件——SSE 据此刷新前端、调度器据此重排 timer。调度器自身用 store 的低层
 * 认领/结算接口，不经本服务。
 */
export class AutomationService {
    constructor(private readonly store: AutomationStore = getAutomationStore()) {}

    async list(filter: AutomationListFilter = 'all'): Promise<AutomationView[]> {
        const all = await this.store.list();
        const picked =
            filter === 'enabled'
                ? all.filter((a) => a.enabled)
                : filter === 'inactive'
                  ? all.filter((a) => !a.enabled)
                  : all;
        return picked.map(toView);
    }

    async get(id: string): Promise<AutomationView | null> {
        const r = await this.store.get(id);
        return r ? toView(r) : null;
    }

    /** 创建任务。source 区分管理页与会话工具，用于审计埋点。 */
    async create(input: AutomationCreateRequest, source: 'ui' | 'tool' = 'ui'): Promise<AutomationView> {
        const r = await this.store.create(input);
        recordAutomationAudit({ event: 'create', automationId: r.id, source, kind: r.schedule.kind });
        this.changed(r.id);
        return toView(r);
    }

    async update(id: string, patch: AutomationUpdateRequest): Promise<AutomationView> {
        const r = await this.store.update(id, patch);
        recordAutomationAudit({ event: 'update', automationId: id, kind: r.schedule.kind });
        this.changed(id);
        return toView(r);
    }

    async setEnabled(id: string, enabled: boolean): Promise<AutomationView> {
        const r = await this.store.setEnabled(id, enabled);
        recordAutomationAudit({ event: enabled ? 'enable' : 'disable', automationId: id });
        this.changed(id);
        return toView(r);
    }

    async delete(id: string): Promise<void> {
        const before = await this.store.get(id);
        await this.store.delete(id);
        recordAutomationAudit({ event: 'delete', automationId: id, kind: before?.schedule.kind });
        this.changed(id);
    }

    /** 立即运行：拉起一次手动触发，返回本次 runId（供前端关联）。 */
    async runNow(id: string): Promise<string> {
        const r = await this.store.requestRunNow(id);
        this.changed(id);
        // 下一轮 drive 会用 `${id}:${nextRunAt}` 作为 runId；此处返回一致值供前端关联。
        return `${id}:${r.nextRunAt ?? Date.now()}`;
    }

    async listRuns(id: string): Promise<AutomationRunView[]> {
        const runs = await this.store.listRuns(id);
        return runs.map((r) => toRunView(id, r));
    }

    private changed(id: string): void {
        automationEvents.emit({ type: 'changed', automationId: id });
    }
}

let service: AutomationService | null = null;

export function getAutomationService(): AutomationService {
    if (!service) service = new AutomationService();
    return service;
}
