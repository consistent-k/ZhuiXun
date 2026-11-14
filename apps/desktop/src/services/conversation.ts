import type { Message } from '@/types/chat';
import request, { type BaseResponse } from '@/utils/request';

/** 会话来源：桌面端会话缺省；渠道会话带 channelId + IM 用户 id，供侧栏「渠道」分区分桶 */
export interface ConversationOrigin {
    kind: 'channel';
    channelId: string;
    channelName?: string;
    imUserId: string;
}

/** 会话列表元信息（不含 messages，供侧栏渲染） */
export interface ConversationMeta {
    id: string;
    title: string;
    /** 归属项目 id；缺省表示「未分组」 */
    projectId?: string;
    /** 会话级表达风格覆盖；缺省表示跟随全局默认 */
    personaId?: string;
    /** 会话来源；缺省=桌面端会话，渠道会话带 origin */
    origin?: ConversationOrigin;
    createdAt: number;
    updatedAt: number;
}

/** 会话全量（含消息与序列化版本） */
export interface SavedConversation extends ConversationMeta {
    version: number;
    messages: Message[];
}

/** upsert 入参（updatedAt 由后端赋值，不传） */
export interface ConversationUpsertInput {
    title: string;
    projectId?: string;
    personaId?: string;
    createdAt: number;
    messages: Message[];
}

/** 拉取会话列表（仅元信息） */
export function fetchConversationsApi(): Promise<BaseResponse<ConversationMeta[]>> {
    return request.get('/api/conversations');
}

/**
 * 拉取单个会话全量（含消息）。
 * @param id 会话 id
 * @param hideError 隐藏全局错误提示（用于探测性拉取，如失效深链的兜底，避免误弹 toast）
 */
export function fetchConversationApi(id: string, hideError?: boolean): Promise<BaseResponse<SavedConversation>> {
    return request.get(`/api/conversations/${id}`, { hideError });
}

/**
 * 幂等 upsert 整个会话（新建与保存均走这里）。
 * @param hideError 隐藏全局错误提示（用于后台建会话，失败会由后续保存补建）
 */
export function saveConversationApi(
    id: string,
    input: ConversationUpsertInput,
    hideError?: boolean
): Promise<BaseResponse<ConversationMeta>> {
    return request.put(`/api/conversations/${id}`, { data: input, hideError });
}

/** 删除单个会话 */
export function deleteConversationApi(id: string): Promise<BaseResponse<{ id: string }>> {
    return request.delete(`/api/conversations/${id}`);
}

/** 重命名会话（轻量 PATCH：仅改标题，不传 messages；后端置标题锁，不被整单写穿或 AI 标题覆盖） */
export function renameConversationApi(id: string, title: string): Promise<BaseResponse<ConversationMeta>> {
    return request.patch(`/api/conversations/${id}/title`, { data: { title } });
}

/** 设置/清除会话级风格覆盖；personaId 为 null 表示跟随全局默认 */
export function setConversationPersonaApi(
    id: string,
    personaId: string | null
): Promise<BaseResponse<ConversationMeta>> {
    return request.patch(`/api/conversations/${id}/persona`, { data: { personaId } });
}

/** 清空全部会话 */
export function clearConversationsApi(): Promise<BaseResponse<{ cleared: number }>> {
    return request.delete('/api/conversations');
}

/** 回滚结果：受影响文件清单 + 截断后的会话元信息 */
export interface RewindResult {
    meta: ConversationMeta;
    files: { restored: string[]; deleted: string[]; skipped: string[] };
}

/** 回滚到指定用户消息：还原该消息所在用户轮及其后 Write/Edit 触碰的文件，并把对话截断到该消息之前 */
export function rewindConversationApi(id: string, toMessageId: string): Promise<BaseResponse<RewindResult>> {
    return request.post(`/api/conversations/${id}/rewind`, { data: { toMessageId } });
}

/** 当前进行中的会话 id（刷新后据此恢复流式、并在侧栏标注「生成中」）；探测性请求，静默失败 */
export function fetchActiveStreamsApi(): Promise<BaseResponse<{ ids: string[] }>> {
    return request.get('/api/chat/active', { hideError: true });
}

/** 会话导出包（全部会话全量快照） */
export interface ConversationExport {
    version: number;
    exportedAt: number;
    conversations: SavedConversation[];
}

/** 导出全部会话（返回 JSON 包，前端存为文件） */
export function exportConversationsApi(): Promise<BaseResponse<ConversationExport>> {
    return request.get('/api/conversations/export');
}

/** 导入会话（JSON 包或会话数组）；id 冲突由后端重映射为新 uuid */
export function importConversationsApi(
    conversations: SavedConversation[]
): Promise<BaseResponse<{ imported: number; remapped: Record<string, string> }>> {
    return request.post('/api/conversations/import', { data: { conversations } });
}
