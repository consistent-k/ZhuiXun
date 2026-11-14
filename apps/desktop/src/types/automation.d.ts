import type {
    AutomationCreateRequest,
    AutomationDispatchStatus,
    AutomationEvent,
    AutomationKind,
    AutomationLifecycleStatus,
    AutomationRunOutcome,
    AutomationRunView,
    AutomationSchedule,
    AutomationUpdateRequest,
    AutomationView
} from '@zhuixun/shared';

/** 契约 DTO 复用 @zhuixun/shared，这里转发并补充前端专用结构。 */
export type {
    AutomationCreateRequest,
    AutomationDispatchStatus,
    AutomationEvent,
    AutomationKind,
    AutomationLifecycleStatus,
    AutomationRunOutcome,
    AutomationRunView,
    AutomationSchedule,
    AutomationUpdateRequest,
    AutomationView
};

/** 列表筛选态：按启用/停用/全部过滤 */
export type AutomationFilter = 'enabled' | 'inactive' | 'all';

/** 运行历史分页响应 */
export interface AutomationRunsPage {
    runs: AutomationRunView[];
    total: number;
}
