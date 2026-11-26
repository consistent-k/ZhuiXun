/** mcp 模块公开契约：MCP server 配置、连接管理、工具适配与 OAuth。 */
export type { MCPClient, MCPConnectResult, MCPServerConfig, MCPServerStatus } from './manager';
export { MCPClientManager } from './manager';
export type { MCPConfigFile } from './config';
export { loadMCPConfig, mcpConfigToServerConfigs, saveMCPConfig } from './config';
export { MCPToolAdapter } from './adapter';
export { MCPToolDiscovery } from './discovery';
export { setConfigResolver } from './oauth';
export {
    clearPendingAuth,
    completeOAuthFlow,
    completePendingAuth,
    consumeOAuthState,
    createOAuthState,
    getPendingAuth,
    resolveOAuthState,
    setPendingAuth,
    startOAuthFlow,
    tokenStore
} from './oauth';

export { connectorCatalog, createConnectorConfig } from './catalog';
