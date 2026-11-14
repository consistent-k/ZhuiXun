import type { ToolLabelInfo } from '@/types/tool';
import request, { type BaseResponse } from '@/utils/request';

/**
 * 拉「工具名 → 标签」全量映射（技能工具 + 已连接 MCP 工具由后端合并）。
 * 后台静默（hideError）：失败时前端回退显示工具原名，不打扰用户。
 */
export function fetchToolLabelsApi(): Promise<BaseResponse<Record<string, ToolLabelInfo>>> {
    return request.get('/api/tools/labels', { hideError: true });
}
