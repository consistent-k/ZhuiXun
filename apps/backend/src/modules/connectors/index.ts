/** 连接器模块：可信应用声明、字段校验、CLI 生命周期与 SDK 工具装配的唯一公开面。 */
export { connectorDefinitions, connectorCatalog, createConnectorConfig, validateConnectorValues } from './catalog';
export type { ConnectorDefinition, CliDefinition } from './catalog';
export { CliConnectorService, getCliConnectorService, disposeCliConnectors } from './cli-service';
export { createCliConnectorTools } from './tools';
