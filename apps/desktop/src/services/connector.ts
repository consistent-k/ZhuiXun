import type { ConnectorApp, ConnectorConnection, ConnectorConnectInput } from '@zhuixun/shared';

import request, { type BaseResponse } from '@/utils/request';

export type { ConnectorApp, ConnectorConnection, ConnectorConnectInput };
export type ConnectorAction = 'connect' | 'install' | 'auth' | 'refresh' | 'enable' | 'disable' | 'disconnect';

/** 获取内置应用的展示信息与表单声明。 */
export function fetchConnectorCatalogApi(): Promise<BaseResponse<ConnectorApp[]>> {
    return request.get('/api/connectors/apps');
}
/** 获取统一连接状态，不返回凭证明文。 */
export function fetchConnectorConnectionsApi(): Promise<BaseResponse<ConnectorConnection[]>> {
    return request.get('/api/connectors/connections');
}
/** 对声明式连接执行生命周期操作，命令与端点由后端决定。 */
export function connectorActionApi(
    id: string,
    action: ConnectorAction,
    input?: ConnectorConnectInput & { force?: boolean }
): Promise<BaseResponse<ConnectorConnection>> {
    return request.post(`/api/connectors/${encodeURIComponent(id)}/${action}`, { data: input ?? {} });
}
