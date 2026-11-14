import type { SkillDetail, SkillListItem, SkillUpsertBody } from '@/types/skill';
import request, { API_BASE_URL, type BaseResponse } from '@/utils/request';

export function fetchSkillsApi(): Promise<BaseResponse<SkillListItem[]>> {
    return request.get('/api/skills');
}

export function fetchSkillDetailApi(id: string): Promise<BaseResponse<SkillDetail>> {
    return request.get(`/api/skills/${encodeURIComponent(id)}`);
}

export function createSkillApi(body: SkillUpsertBody): Promise<BaseResponse<{ id: string }>> {
    return request.post('/api/skills', { data: body });
}

export function updateSkillApi(id: string, body: SkillUpsertBody): Promise<BaseResponse<{ id: string }>> {
    return request.put(`/api/skills/${encodeURIComponent(id)}`, { data: body });
}

export function deleteSkillApi(id: string): Promise<BaseResponse<{ id: string; deleted: boolean }>> {
    return request.delete(`/api/skills/${encodeURIComponent(id)}`);
}

export function toggleSkillApi(id: string): Promise<BaseResponse<{ id: string; disabled: boolean }>> {
    return request.patch(`/api/skills/${encodeURIComponent(id)}/toggle`);
}

/** 上传技能包（.md 或 .zip），multipart。显式传 `Content-Type: multipart/form-data` 覆盖 request
 * 实例默认的 application/json——否则 axios 会把 FormData JSON 序列化（File 变成 {}）导致后端拿不到文件；
 * boundary 由浏览器自动补上。错误经 request 拦截器统一 toast。
 */
export function uploadSkillApi(file: File): Promise<BaseResponse<{ id: string }>> {
    const form = new FormData();
    form.append('file', file);
    return request.post('/api/skills/upload', { data: form, headers: { 'Content-Type': 'multipart/form-data' } });
}

/** 导出技能为 .zip 的下载地址（供 <a> 直接下载）。 */
export function getSkillExportUrl(id: string): string {
    return `${API_BASE_URL}/api/skills/${encodeURIComponent(id)}/export`;
}
