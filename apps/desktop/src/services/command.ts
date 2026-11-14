import type { CompactionMarker } from '@zhuixun/shared';

import type { CommandDetail, CommandExpandResult, CommandSummary, CommandUpsertInput } from '@/types/command';
import request, { type BaseResponse } from '@/utils/request';

/** 命令列表：内置（前端本地处理）+ 用户命令（不含正文） */
export interface CommandListView {
    builtin: CommandSummary[];
    user: CommandSummary[];
}

export function fetchCommandsApi(): Promise<BaseResponse<CommandListView>> {
    return request.get('/api/commands');
}

export function fetchCommandApi(name: string): Promise<BaseResponse<CommandDetail>> {
    return request.get(`/api/commands/${encodeURIComponent(name)}`);
}

/** 新建 / 覆盖保存命令（名称非法或与内置同名返回 400） */
export function saveCommandApi(name: string, input: CommandUpsertInput): Promise<BaseResponse<CommandDetail>> {
    return request.put(`/api/commands/${encodeURIComponent(name)}`, { data: input });
}

export function deleteCommandApi(name: string): Promise<BaseResponse<{ name: string }>> {
    return request.delete(`/api/commands/${encodeURIComponent(name)}`);
}

/** 发送前展开 `/name args`；未命中按普通文本发送（hideError：失败也按原文发送，不打扰用户） */
export function expandCommandApi(text: string): Promise<BaseResponse<CommandExpandResult>> {
    return request.post('/api/commands/expand', { data: { text }, hideError: true });
}

/** 手动压缩结果：changed=false 表示当前上下文无需压缩 */
export interface CompactResult {
    changed: boolean;
    marker?: CompactionMarker;
    messageId?: string;
}

/** `/compact [说明]`：手动压缩会话上下文（生成中返回 409） */
export function compactConversationApi(id: string, instructions?: string): Promise<BaseResponse<CompactResult>> {
    return request.post(`/api/conversations/${encodeURIComponent(id)}/compact`, {
        data: instructions ? { instructions } : {}
    });
}
