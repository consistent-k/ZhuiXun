import type { ConversationMeta } from '@/services/conversation';
import type { ProjectMeta, ProjectUpsertInput, SavedProject } from '@/types/project';
import request, { type BaseResponse } from '@/utils/request';

/** 拉取项目列表（仅元信息）。includeDeleted=true 时包含软删项目（回收站用）。 */
export function fetchProjectsApi(includeDeleted = false): Promise<BaseResponse<ProjectMeta[]>> {
    return request.get('/api/projects', { params: includeDeleted ? { includeDeleted: 1 } : undefined });
}

/** 拉取单个项目全量（含指令/技能集） */
export function fetchProjectApi(id: string): Promise<BaseResponse<SavedProject>> {
    return request.get(`/api/projects/${encodeURIComponent(id)}`);
}

/** 创建项目（id 由后端生成） */
export function createProjectApi(input: ProjectUpsertInput): Promise<BaseResponse<ProjectMeta>> {
    return request.post('/api/projects', { data: input });
}

/** 更新项目（名称/指令/技能集/归档/工作目录集合等） */
export function updateProjectApi(id: string, input: ProjectUpsertInput): Promise<BaseResponse<ProjectMeta>> {
    return request.put(`/api/projects/${encodeURIComponent(id)}`, { data: input });
}

/** 切换项目信任态（独立端点，便于前端确认弹窗承载） */
export function trustProjectApi(id: string, trusted: boolean): Promise<BaseResponse<ProjectMeta>> {
    return request.put(`/api/projects/${encodeURIComponent(id)}/trust`, { data: { trusted } });
}

/**
 * 删除项目。
 * @param opts.hard true 彻底删除（含项目目录与记忆）；默认软删（可从回收站恢复）。
 * @param opts.cascade 仅彻底删除时生效：true 连同项目下会话一起删，否则会话回落「未分组」。
 */
export function deleteProjectApi(
    id: string,
    opts: { hard?: boolean; cascade?: boolean } = {}
): Promise<BaseResponse<{ id: string; mode: 'soft' | 'hard'; cascade?: boolean; movedSessions?: string[] }>> {
    const flags = [opts.hard ? 'hard=1' : '', opts.hard && opts.cascade ? 'cascade=1' : ''].filter(Boolean);
    const qs = flags.length ? `?${flags.join('&')}` : '';
    return request.delete(`/api/projects/${encodeURIComponent(id)}${qs}`);
}

/** 恢复软删项目 */
export function restoreProjectApi(id: string): Promise<BaseResponse<ProjectMeta>> {
    return request.post(`/api/projects/${encodeURIComponent(id)}/restore`);
}

/**
 * 移动会话到项目（轻量，不重传 messages）。projectId 传 null 表示移出到未分组。
 * 归属在会话侧，因此接口挂在 conversations 路由下。
 */
export function moveConversationApi(
    conversationId: string,
    projectId: string | null
): Promise<BaseResponse<ConversationMeta>> {
    return request.patch(`/api/conversations/${encodeURIComponent(conversationId)}/project`, { data: { projectId } });
}

/** 校验工作目录路径是否为一个可访问的目录（绝对路径） */
export function validateProjectPathApi(path: string): Promise<BaseResponse<{ ok: boolean; reason?: string }>> {
    return request.post('/api/projects/validate-path', { data: { path }, hideError: true });
}

/** 后端目录浏览器：某目录下的子目录列表（浏览的是后端主机文件系统） */
export interface BrowseDirResult {
    /** 当前目录绝对路径 */
    path: string;
    /** 上级目录；到根时为 null */
    parent: string | null;
    /** 用户主目录（作为「回到主目录」的锚点） */
    home: string;
    /** 当前目录下的子目录 */
    entries: { name: string; path: string }[];
}

/**
 * 列出后端主机上某个目录的子目录，供目录导航弹窗选择工作目录。
 * @param path 目标目录绝对路径；缺省时后端返回用户主目录
 */
export function browseDirApi(path?: string): Promise<BaseResponse<BrowseDirResult>> {
    return request.get('/api/projects/browse-dir', { params: path ? { path } : undefined, hideError: true });
}
