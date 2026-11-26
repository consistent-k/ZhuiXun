import type { ConnectorApp } from '@zhuixun/shared';

import type { MCPServerItem, MCPToolItem } from '@/types/mcp';
import request, { type BaseResponse } from '@/utils/request';

export function fetchMCPServersApi(): Promise<BaseResponse<MCPServerItem[]>> {
    return request.get('/api/mcp/servers');
}

export function addMCPServerApi(
    server: Omit<MCPServerItem, 'status' | 'error' | 'toolCount' | 'authenticated'>
): Promise<BaseResponse<{ name: string; status: string; error?: string }>> {
    return request.post('/api/mcp/servers', { data: server });
}

export function updateMCPServerApi(
    name: string,
    server: Omit<MCPServerItem, 'status' | 'error' | 'toolCount' | 'authenticated'>
): Promise<BaseResponse<{ name: string; status: string; error?: string }>> {
    return request.put(`/api/mcp/servers/${encodeURIComponent(name)}`, { data: server });
}

export function deleteMCPServerApi(name: string): Promise<BaseResponse<{ name: string; deleted: boolean }>> {
    return request.delete(`/api/mcp/servers/${encodeURIComponent(name)}`);
}

export function reconnectMCPServerApi(
    name: string
): Promise<BaseResponse<{ name: string; status: string; error?: string }>> {
    return request.post(`/api/mcp/servers/${encodeURIComponent(name)}/reconnect`);
}

export function toggleMCPServerApi(
    name: string
): Promise<BaseResponse<{ name: string; disabled: boolean; status: string; error?: string }>> {
    return request.patch(`/api/mcp/servers/${encodeURIComponent(name)}/toggle`);
}

export function fetchMCPServerToolsApi(name: string): Promise<BaseResponse<MCPToolItem[]>> {
    return request.get(`/api/mcp/servers/${encodeURIComponent(name)}/tools`);
}

// ── OAuth ──

export interface OAuthAuthResponse {
    authorizationUrl?: string;
    authenticated?: boolean;
}

export function startMCPServerAuthApi(name: string, force = false): Promise<BaseResponse<OAuthAuthResponse>> {
    return request.post(`/api/mcp/servers/${encodeURIComponent(name)}/auth${force ? '?force=1' : ''}`);
}

/** 获取内置应用目录。 */
export function fetchConnectorAppsApi(): Promise<BaseResponse<ConnectorApp[]>> {
    return request.get('/api/mcp/apps');
}

/** 连接内置应用，凭证仅在本次提交时发送，不随列表返回。 */
export function connectAppApi(
    id: string,
    token?: string
): Promise<BaseResponse<{ name: string; status: string; error?: string }>> {
    return request.post(`/api/mcp/apps/${encodeURIComponent(id)}/connect`, { data: { token } });
}
