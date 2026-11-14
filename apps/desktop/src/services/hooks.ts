import type { HookAuditEntry, HooksView } from '@/types/hooks';
import request, { type BaseResponse } from '@/utils/request';

/** 获取 hooks.json 的只读视图与信任状态 */
export function fetchHooksApi(): Promise<BaseResponse<HooksView>> {
    return request.get('/api/hooks');
}

/** 信任当前配置（hash 必须与此刻文件一致，否则 409）/ 切换总开关 */
export function updateHooksTrustApi(params: { hash?: string; enabled?: boolean }): Promise<BaseResponse<HooksView>> {
    return request.put('/api/hooks/trust', { data: params });
}

/** 最近的 hook 执行记录（新在前） */
export function fetchHookAuditApi(limit = 50): Promise<BaseResponse<HookAuditEntry[]>> {
    return request.get('/api/hooks/audit', { params: { limit } });
}
