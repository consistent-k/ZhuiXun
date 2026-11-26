import type { ConnectorConnection } from '@zhuixun/shared';
import { Hono } from 'hono';

import { oauthCallbackUrl } from '@/config/server';
import { fail, notReady, ok } from '@/http/respond';
import {
    connectorCatalog,
    connectorDefinitions,
    createConnectorConfig,
    getCliConnectorService,
    type CliConnectorService
} from '@/modules/connectors';
import {
    clearPendingAuth,
    getPendingAuth,
    saveMCPConfig,
    setPendingAuth,
    startOAuthFlow,
    tokenStore,
    type MCPClientManager
} from '@/modules/mcp';

type Manager = Pick<
    MCPClientManager,
    'getConfigs' | 'getAllStatus' | 'addServer' | 'updateServer' | 'removeServer' | 'disableServer'
>;

/** 统一应用连接 API；安装/授权命令只来自后端目录声明，客户端仅提交表单值与动作。 */
export function createConnectorsRouter(
    getManager: () => Manager | undefined,
    getConfigPath: () => string,
    getCli: () => CliConnectorService = getCliConnectorService
) {
    const router = new Hono();
    let queue: Promise<unknown> = Promise.resolve();
    const mutate = <T>(action: () => Promise<T>) => {
        const next = queue.then(action);
        queue = next.catch(() => undefined);
        return next;
    };
    const persist = async (manager: Manager) => {
        await saveMCPConfig(getConfigPath(), {
            servers: Object.fromEntries(manager.getConfigs().map(({ name, ...config }) => [name, config]))
        });
    };
    const mcpView = async (
        id: string,
        manager: Manager,
        statuses?: Awaited<ReturnType<Manager['getAllStatus']>>
    ): Promise<ConnectorConnection> => {
        const config = manager.getConfigs().find((item) => item.connectorId === id);
        const status = (statuses ?? (await manager.getAllStatus())).find((item) => item.name === config?.name);
        const pending = config ? getPendingAuth(config.name) : undefined;
        return {
            id,
            serverName: config?.name,
            configured: !!config,
            enabled: !!config && !config.disabled,
            status: !config
                ? 'disconnected'
                : config.disabled
                  ? 'disabled'
                  : status?.status === 'connected'
                    ? 'connected'
                    : pending && !pending.completed
                      ? 'authorizing'
                      : status?.status === 'failed'
                        ? 'failed'
                        : 'disconnected',
            toolCount: status?.toolCount ?? 0,
            error: status?.error ? '连接失败，请检查凭证或重新授权' : undefined,
            authorizationUrl: pending && !pending.completed ? pending.authorizationUrl : undefined
        };
    };
    router.get('/api/connectors/apps', (c) => ok(c, connectorCatalog));
    router.get('/api/connectors/connections', async (c) => {
        const manager = getManager();
        if (!manager) return notReady(c);
        const [cli, statuses] = await Promise.all([getCli().list(), manager.getAllStatus()]);
        const mcp = await Promise.all(
            connectorDefinitions.filter((item) => item.mcp).map((item) => mcpView(item.app.id, manager, statuses))
        );
        return ok(c, [...mcp, ...cli]);
    });
    router.post('/api/connectors/:id/:action', async (c) => {
        const id = c.req.param('id'),
            action = c.req.param('action');
        const definition = connectorDefinitions.find((item) => item.app.id === id);
        if (!definition) return fail(c, 404, '应用不存在');
        if (!['connect', 'install', 'auth', 'refresh', 'enable', 'disable', 'disconnect'].includes(action))
            return fail(c, 400, '不支持的连接操作');
        if (definition.cli) {
            try {
                const service = getCli();
                if (action === 'install') return ok(c, await service.start(id, 'install'));
                if (action === 'connect' || action === 'auth') return ok(c, await service.start(id, 'auth'));
                if (action === 'refresh') return ok(c, await service.refresh(id));
                if (action === 'disconnect') return ok(c, await service.disconnect(id));
                return ok(c, await service.setEnabled(id, action === 'enable'));
            } catch (error) {
                return fail(c, 400, error instanceof Error ? error.message : '操作失败，请重试');
            }
        }
        const manager = getManager();
        if (!manager) return notReady(c);
        if (action === 'install') return fail(c, 400, '此应用无需安装组件');
        const body = await c.req.json<unknown>().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(c, 400, '连接参数格式错误');
        const input = body as { values?: unknown; force?: unknown };
        if (
            input.values !== undefined &&
            (!input.values ||
                typeof input.values !== 'object' ||
                Array.isArray(input.values) ||
                Object.values(input.values).some((value) => typeof value !== 'string'))
        )
            return fail(c, 400, '表单字段格式错误');
        try {
            if (action === 'auth') {
                const config = manager.getConfigs().find((item) => item.connectorId === id);
                if (!config?.url || config.authType !== 'oauth') return fail(c, 400, '请先创建 OAuth 连接');
                if (input.force === true) {
                    tokenStore.clear(config.name);
                    clearPendingAuth(config.name);
                }
                const redirectUrl = oauthCallbackUrl();
                const result = await startOAuthFlow(
                    config.name,
                    config.url,
                    redirectUrl,
                    {
                        redirect_uris: [redirectUrl],
                        client_name: `追寻 (${definition.app.name})`,
                        grant_types: ['authorization_code', 'refresh_token'],
                        response_types: ['code'],
                        scope: config.oauth?.scope
                    },
                    config.oauth?.scope,
                    config.oauth?.clientId
                );
                if (result.authorizationUrl) setPendingAuth(config.name, result.authorizationUrl);
                return ok(c, await mcpView(id, manager));
            }
            return await mutate(async () => {
                const existing = manager.getConfigs().find((item) => item.connectorId === id);
                if (action === 'connect') {
                    const values = input.values as Record<string, string> | undefined;
                    const config =
                        existing && (!values || Object.values(values).every((value) => !value.trim()))
                            ? { ...existing, disabled: false }
                            : createConnectorConfig(id, values);
                    const conflict = manager
                        .getConfigs()
                        .find((item) => item.name === config.name && item.connectorId !== id);
                    if (conflict) return fail(c, 409, '应用连接名称与自定义 MCP 冲突，请先重命名');
                    if (existing) await manager.updateServer(existing.name, config);
                    else await manager.addServer(config);
                } else if (action === 'disconnect') {
                    if (existing) {
                        await manager.removeServer(existing.name);
                        tokenStore.clear(existing.name);
                        clearPendingAuth(existing.name);
                        await tokenStore.flush();
                    }
                } else if (action !== 'refresh') {
                    if (!existing) return fail(c, 400, '应用尚未连接');
                    if (action === 'disable') await manager.disableServer(existing.name);
                    else await manager.updateServer(existing.name, { ...existing, disabled: false });
                }
                if (action !== 'refresh') await persist(manager);
                return ok(c, await mcpView(id, manager));
            });
        } catch {
            return fail(c, 400, '连接操作未完成，请检查配置后重试');
        }
    });
    return router;
}
