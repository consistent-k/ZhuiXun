import type { MemoryOverview, MemoryProjectSummary, MemoryRecord, MemoryScope, MemoryType } from '@/types/memory';
import request, { type BaseResponse } from '@/utils/request';

/** 获取某层总览（开关 + 索引 + 条目清单） */
export function fetchMemoryApi(params?: {
    scope?: MemoryScope;
    projectId?: string;
}): Promise<BaseResponse<MemoryOverview>> {
    return request.get('/api/memory', { params });
}

/** 更新开关（全局）/ 整体改某层索引 */
export function patchMemoryApi(data: {
    enabled?: boolean;
    autoExtract?: boolean;
    autoDream?: boolean;
    scope?: MemoryScope;
    projectId?: string;
    index?: string;
}): Promise<BaseResponse<MemoryOverview>> {
    return request.patch('/api/memory', { data });
}

/** 手动触发记忆整理（dream） */
export function triggerMemoryDreamApi(data?: { projectId?: string }): Promise<BaseResponse<{ started: boolean }>> {
    return request.post('/api/memory/dream', { data: data ?? {} });
}

/** 读单条记忆原文 */
export function fetchMemoryItemApi(params: {
    scope: MemoryScope;
    projectId?: string;
    name: string;
}): Promise<BaseResponse<MemoryRecord>> {
    return request.get('/api/memory/item', { params });
}

/** 新建/覆盖单条记忆 */
export function upsertMemoryItemApi(data: {
    scope: MemoryScope;
    projectId?: string;
    name: string;
    type: MemoryType;
    description: string;
    content: string;
}): Promise<BaseResponse<MemoryRecord>> {
    return request.put('/api/memory/item', { data });
}

/** 删除单条记忆 */
export function deleteMemoryItemApi(params: {
    scope: MemoryScope;
    projectId?: string;
    name: string;
}): Promise<BaseResponse<{ ok: boolean }>> {
    return request.delete('/api/memory/item', { params });
}

/** 列出有项目层记忆的项目 */
export function fetchMemoryProjectsApi(): Promise<BaseResponse<MemoryProjectSummary[]>> {
    return request.get('/api/memory/projects');
}
