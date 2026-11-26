/** 连接表单字段。实际凭证不包含在目录或状态响应中。 */
export interface ConnectorField {
    key: string;
    label: string;
    type: 'text' | 'password';
    required?: boolean;
    placeholder?: string;
    defaultValue?: string;
    format?: 'token' | 'url';
    tokenFromUrl?: { host: string; path: string; param: string; source: 'hash' | 'query' };
}

/** 内置应用的展示与连接表单契约，不暴露启动命令和秘密。 */
export interface ConnectorApp {
    id: string;
    name: string;
    kind: 'mcp' | 'cli';
    description: string;
    category: string;
    auth: 'none' | 'oauth' | 'token' | 'cli';
    website: string;
    credentialUrl?: string;
    fields: ConnectorField[];
    permissions: string[];
    examples: string[];
    notice?: string;
}

export type ConnectorStatus =
    'not-installed' | 'installing' | 'disconnected' | 'authorizing' | 'connected' | 'disabled' | 'failed';

/** 统一连接状态：无任何凭证明文。 */
export interface ConnectorConnection {
    id: string;
    serverName?: string;
    status: ConnectorStatus;
    configured: boolean;
    installed?: boolean;
    enabled: boolean;
    toolCount: number;
    error?: string;
    authorizationUrl?: string;
}

export interface ConnectorConnectInput {
    values?: Record<string, string>;
}
