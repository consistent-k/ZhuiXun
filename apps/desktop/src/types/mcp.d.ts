export type MCPTransport = 'stdio' | 'sse' | 'streamableHttp';
export type MCPServerStatusType = 'connected' | 'failed' | 'disconnected';
export type MCPAuthType = 'none' | 'oauth';

export interface MCPServerOAuthConfig {
    scope?: string;
    clientId?: string;
    clientSecret?: string;
}

export interface MCPServerItem {
    connectorId?: string;
    headers?: Record<string, string>;
    name: string;
    transport: MCPTransport;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    disabled?: boolean;
    authType: MCPAuthType;
    oauth?: MCPServerOAuthConfig;
    authenticated?: boolean;
    status: MCPServerStatusType;
    error?: string;
    toolCount: number;
}

export interface MCPToolItem {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
