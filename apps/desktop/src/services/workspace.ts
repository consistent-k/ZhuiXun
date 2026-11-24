import type { WorkspaceFileReference, WorkspaceFileView, WorkspaceSummary } from '@zhuixun/shared';

import request, { API_BASE_URL, authHeaders } from '@/utils/request';

/** 获取稳定数据集身份，UI 存储不依赖监听端口。 */
export const fetchWorkspaceIdentityApi = () =>
    request.get<{ workspaceInstanceId: string }>('/api/workspace/identity', { hideError: true });
/** 获取服务端摘要快照。 */
export const fetchWorkspaceApi = (id: string) =>
    request.get<WorkspaceSummary[]>(`/api/conversations/${id}/workspace`, { hideError: true });
/** 文件描述符不包含正文，读取前需另行鉴权。 */
export const resolveWorkspaceFileApi = (id: string, ref: WorkspaceFileReference) =>
    request.post<WorkspaceFileView>(`/api/conversations/${id}/files/resolve`, { data: ref, hideError: true });
/** UI 显式确认，仅批准该描述符绑定的文件版本。 */
export const approveWorkspaceFileApi = (id: string, fileId: string) =>
    request.post(`/api/conversations/${id}/files/${fileId}/approve`, { data: { approved: true }, hideError: true });
/** 二进制不经过 JSON 信封拦截器；取消和 Blob 生命周期由预览器管理。 */
export async function readWorkspaceFileApi(id: string, fileId: string, signal: AbortSignal) {
    const response = await fetch(`${API_BASE_URL}/api/conversations/${id}/files/${fileId}/content`, {
        headers: authHeaders(),
        signal
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `文件读取失败（${response.status}）`);
    }
    return response.blob();
}
/** 先经认证签发一次性链接，再交浏览器流式下载，不缓存整个超限文件。 */
export const downloadWorkspaceFileApi = (id: string, fileId: string) =>
    request.post<{ url: string }>(`/api/conversations/${id}/files/${fileId}/download`, { hideError: true });
