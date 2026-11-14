import type { GoalService } from './service';

/**
 * GoalService 单例持有者。
 *
 * 单独成文件而不是塞进 index.ts：装配点（bootstrap/services.ts）写、路由与 agent 工具读，
 * 若放在 index 会与 service 的导出形成初始化顺序隐式依赖。
 */
let service: GoalService | null = null;

export function setGoalService(next: GoalService): void {
    service = next;
}

export function getGoalService(): GoalService {
    if (!service) throw new Error('GoalService 尚未初始化');
    return service;
}
