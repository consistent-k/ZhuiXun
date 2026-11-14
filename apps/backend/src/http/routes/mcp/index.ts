import { Hono } from 'hono';
import { html } from 'hono/html';

import { oauthCallbackUrl } from '@/config/server';
import type { MCPConfigFile } from '@/modules/mcp';
import type { MCPClientManager, MCPServerConfig } from '@/modules/mcp';
import { saveMCPConfig } from '@/modules/mcp';
import {
    tokenStore,
    setPendingAuth,
    getPendingAuth,
    clearPendingAuth,
    startOAuthFlow,
    completeOAuthFlow,
    resolveOAuthState,
    consumeOAuthState
} from '@/modules/mcp';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('MCPOAuth');

// HTTP 层只依赖这些公开能力，测试无需伪造含私有状态的完整 manager。
type MCPRouteManager = Pick<
    MCPClientManager,
    | 'getConfigs'
    | 'getAllStatus'
    | 'addServer'
    | 'updateServer'
    | 'removeServer'
    | 'reconnectServer'
    | 'disableServer'
    | 'getServerTools'
>;

export function createMCPRouter(getManager: () => MCPRouteManager | undefined, getConfigPath: () => string) {
    const mcp = new Hono();

    /** GET /api/mcp/servers — 列出所有 server + 运行时状态 */
    mcp.get('/api/mcp/servers', async (c) => {
        const manager = getManager();
        if (!manager) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const configs = manager.getConfigs();
        const statuses = await manager.getAllStatus();

        const servers = configs.map((cfg) => {
            const st = statuses.find((s) => s.name === cfg.name);
            const hasTokens = !!tokenStore.getTokens(cfg.name);
            return {
                name: cfg.name,
                transport: cfg.transport,
                command: cfg.command,
                args: cfg.args,
                env: cfg.env,
                url: cfg.url,
                disabled: !!cfg.disabled,
                authType: cfg.authType || 'none',
                oauth: cfg.oauth,
                authenticated: hasTokens,
                status: st?.status || 'disconnected',
                error: st?.error,
                toolCount: st?.toolCount || 0
            };
        });

        return c.json({ code: 0, data: servers });
    });

    /** POST /api/mcp/servers — 新增 server */
    mcp.post('/api/mcp/servers', async (c) => {
        const manager = getManager();
        if (!manager) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const body = await c.req.json();
        const { name, transport, command, args, env, url, disabled, authType, oauth } = body;

        if (!name || !transport) {
            return c.json({ code: 400, message: 'name 和 transport 为必填项' }, 400);
        }

        if (!['stdio', 'sse', 'streamableHttp'].includes(transport)) {
            return c.json({ code: 400, message: 'transport 必须为 stdio / sse / streamableHttp' }, 400);
        }

        if (transport === 'stdio' && !command) {
            return c.json({ code: 400, message: 'stdio 模式下 command 为必填项' }, 400);
        }

        if ((transport === 'sse' || transport === 'streamableHttp') && !url) {
            return c.json({ code: 400, message: `${transport} 模式下 url 为必填项` }, 400);
        }

        // 检查重名
        const existing = manager.getConfigs().find((c) => c.name === name);
        if (existing) {
            return c.json({ code: 409, message: `Server "${name}" 已存在` }, 409);
        }

        const config: MCPServerConfig = {
            name,
            transport,
            command,
            args,
            env,
            url,
            disabled: !!disabled,
            authType: authType || 'none',
            oauth
        };
        const result = await manager.addServer(config);

        // 持久化
        await persistConfig(manager, getConfigPath);

        return c.json({
            code: 0,
            data: { name, status: result.ok ? 'connected' : 'failed', error: result.error }
        });
    });

    /** PUT /api/mcp/servers/:name — 更新 server */
    mcp.put('/api/mcp/servers/:name', async (c) => {
        const manager = getManager();
        if (!manager) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const oldName = c.req.param('name');
        const body = await c.req.json();
        const { name, transport, command, args, env, url, disabled, authType, oauth } = body;

        if (!name || !transport) {
            return c.json({ code: 400, message: 'name 和 transport 为必填项' }, 400);
        }

        if (!['stdio', 'sse', 'streamableHttp'].includes(transport)) {
            return c.json({ code: 400, message: 'transport 必须为 stdio / sse / streamableHttp' }, 400);
        }

        if ((transport === 'sse' || transport === 'streamableHttp') && !url) {
            return c.json({ code: 400, message: `${transport} 模式下 url 为必填项` }, 400);
        }

        // 如果改了 name，需要检查新名称是否冲突
        if (name !== oldName) {
            const conflicting = manager.getConfigs().find((c) => c.name === name);
            if (conflicting) {
                return c.json({ code: 409, message: `Server "${name}" 已存在` }, 409);
            }
        }

        const oldConfig = manager.getConfigs().find((c) => c.name === oldName);
        if (!oldConfig) {
            return c.json({ code: 404, message: `Server "${oldName}" 不存在` }, 404);
        }

        // 如果 name 变了，先删旧的再加新的
        if (name !== oldName) {
            await manager.removeServer(oldName);
        }

        const config: MCPServerConfig = {
            name,
            transport,
            command,
            args,
            env,
            url,
            disabled: !!disabled,
            authType: authType || 'none',
            oauth
        };
        const result = name !== oldName ? await manager.addServer(config) : await manager.updateServer(oldName, config);

        // 持久化
        await persistConfig(manager, getConfigPath);

        return c.json({
            code: 0,
            data: { name, status: result.ok ? 'connected' : 'failed', error: result.error }
        });
    });

    /** DELETE /api/mcp/servers/:name — 删除 server */
    mcp.delete('/api/mcp/servers/:name', async (c) => {
        const manager = getManager();
        if (!manager) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const name = c.req.param('name');
        const config = manager.getConfigs().find((c) => c.name === name);
        if (!config) {
            return c.json({ code: 404, message: `Server "${name}" 不存在` }, 404);
        }

        await manager.removeServer(name);

        // 持久化
        await persistConfig(manager, getConfigPath);

        return c.json({ code: 0, data: { name, deleted: true } });
    });

    /** POST /api/mcp/servers/:name/reconnect — 手动重连 */
    mcp.post('/api/mcp/servers/:name/reconnect', async (c) => {
        const manager = getManager();
        if (!manager) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const name = c.req.param('name');
        const result = await manager.reconnectServer(name);

        return c.json({
            code: 0,
            data: { name, status: result.ok ? 'connected' : 'failed', error: result.error }
        });
    });

    /** PATCH /api/mcp/servers/:name/toggle — 切换启用/禁用状态 */
    mcp.patch('/api/mcp/servers/:name/toggle', async (c) => {
        const manager = getManager();
        if (!manager) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const name = c.req.param('name');
        const config = manager.getConfigs().find((cfg) => cfg.name === name);
        if (!config) {
            return c.json({ code: 404, message: `Server "${name}" 不存在` }, 404);
        }

        const newDisabled = !config.disabled;
        const updatedConfig: MCPServerConfig = { ...config, disabled: newDisabled };

        let result;
        if (newDisabled) {
            // 禁用：断开连接但保留配置（原位置），避免列表顺序变动
            await manager.disableServer(name);
            result = { name, ok: true };
        } else {
            // 启用：更新配置并连接
            result = await manager.updateServer(name, updatedConfig);
        }

        await persistConfig(manager, getConfigPath);

        return c.json({
            code: 0,
            data: {
                name,
                disabled: newDisabled,
                status: result.ok ? 'connected' : 'failed',
                error: result.error
            }
        });
    });

    /** GET /api/mcp/servers/:name/tools — 获取 server 的工具列表 */
    mcp.get('/api/mcp/servers/:name/tools', async (c) => {
        const manager = getManager();
        if (!manager) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const name = c.req.param('name');
        const tools = await manager.getServerTools(name);

        return c.json({ code: 0, data: tools });
    });

    /** POST /api/mcp/servers/:name/auth — 触发 OAuth 授权流程 */
    mcp.post('/api/mcp/servers/:name/auth', async (c) => {
        const manager = getManager();
        if (!manager) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const name = c.req.param('name');
        const config = manager.getConfigs().find((cfg) => cfg.name === name);
        if (!config) {
            return c.json({ code: 404, message: `Server "${name}" 不存在` }, 404);
        }

        if (config.authType !== 'oauth') {
            return c.json({ code: 400, message: `Server "${name}" 未启用 OAuth 认证` }, 400);
        }

        if (!config.url) {
            return c.json({ code: 400, message: `Server "${name}" 缺少 url 配置` }, 400);
        }

        const redirectUrl = oauthCallbackUrl();

        try {
            const result = await startOAuthFlow(
                name,
                config.url,
                redirectUrl,
                {
                    redirect_uris: [redirectUrl],
                    client_name: `追寻 (${name})`,
                    grant_types: ['authorization_code'],
                    response_types: ['code'],
                    scope: config.oauth?.scope
                },
                config.oauth?.scope,
                config.oauth?.clientId
            );

            if (result.authenticated) {
                return c.json({ code: 0, data: { authenticated: true } });
            }

            if (result.authorizationUrl) {
                setPendingAuth(name, result.authorizationUrl);
                return c.json({
                    code: 0,
                    data: { authorizationUrl: result.authorizationUrl }
                });
            }

            return c.json({ code: 500, message: '授权流程异常' }, 500);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error('鉴权失败', { server: name, message });
            return c.json({ code: 500, message: `授权失败: ${message}` }, 500);
        }
    });

    /** GET /api/mcp/servers/:name/auth/status — 查询 OAuth 授权状态 */
    mcp.get('/api/mcp/servers/:name/auth/status', async (c) => {
        const name = c.req.param('name');
        const pending = getPendingAuth(name);
        const hasTokens = !!tokenStore.getTokens(name);

        return c.json({
            code: 0,
            data: {
                authenticated: hasTokens,
                pendingAuthorization: pending ? !pending.completed : false,
                authorizationUrl: pending && !pending.completed ? pending.authorizationUrl : undefined
            }
        });
    });

    /** POST /api/mcp/servers/:name/auth/revoke — 撤销 OAuth token */
    mcp.post('/api/mcp/servers/:name/auth/revoke', async (c) => {
        const name = c.req.param('name');
        tokenStore.clear(name);
        clearPendingAuth(name);

        return c.json({ code: 0, data: { revoked: true } });
    });

    /** GET /api/mcp/oauth/callback — OAuth 回调端点 */
    mcp.get('/api/mcp/oauth/callback', async (c) => {
        const code = c.req.query('code');
        const state = c.req.query('state');
        const error = c.req.query('error');

        if (error) {
            return c.html(html`
                <html>
                    <body style="font-family:sans-serif;text-align:center;padding:60px">
                        <h2>❌ 授权失败</h2>
                        <p>${error}</p>
                        <p>请关闭此页面返回应用。</p>
                    </body>
                </html>
            `);
        }

        if (!code) {
            return c.html(html`
                <html>
                    <body style="font-family:sans-serif;text-align:center;padding:60px">
                        <h2>❌ 缺少授权码</h2>
                        <p>请关闭此页面返回应用。</p>
                    </body>
                </html>
            `);
        }

        // 以随机 state 反查是哪个 server（CSRF 防护）：查不到即视为非法/过期回调
        const serverName = resolveOAuthState(state);

        if (!serverName) {
            return c.html(html`
                <html>
                    <body style="font-family:sans-serif;text-align:center;padding:60px">
                        <h2>⚠️ 无效的 state 参数</h2>
                        <p>无法确定是哪个服务的授权回调，或该请求已过期。</p>
                        <p>请关闭此页面返回应用。</p>
                    </body>
                </html>
            `);
        }

        const manager = getManager();
        const config = manager?.getConfigs().find((cfg) => cfg.name === serverName);

        if (!config) {
            return c.html(html`
                <html>
                    <body style="font-family:sans-serif;text-align:center;padding:60px">
                        <h2>❌ 未找到服务: ${serverName}</h2>
                        <p>请关闭此页面返回应用。</p>
                    </body>
                </html>
            `);
        }

        try {
            await completeOAuthFlow(serverName, code);
            // state 一次性，成功后消费掉
            if (state) consumeOAuthState(state);

            // 尝试重连（async 方法，必须捕获拒绝，否则会产生 unhandledRejection 导致进程退出）
            try {
                await manager?.reconnectServer(serverName);
            } catch (reconnectError) {
                log.error('鉴权后重连失败', { server: serverName, err: reconnectError });
            }

            return c.html(html`
                <html>
                    <body style="font-family:sans-serif;text-align:center;padding:60px">
                        <h2>✅ 授权成功</h2>
                        <p>已成功授权 ${serverName}。可以关闭此页面返回应用。</p>
                        <script>
                            setTimeout(() => window.close(), 2000);
                        </script>
                    </body>
                </html>
            `);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error('回调 token 交换失败', { server: serverName, message });
            return c.html(html`
                <html>
                    <body style="font-family:sans-serif;text-align:center;padding:60px">
                        <h2>❌ Token 交换失败</h2>
                        <p>${message}</p>
                        <p>请关闭此页面返回应用。</p>
                    </body>
                </html>
            `);
        }
    });

    return mcp;
}

/** 将当前 manager 中的配置持久化到 .mcp.json */
async function persistConfig(manager: MCPRouteManager, getConfigPath: () => string): Promise<void> {
    const configs = manager.getConfigs();
    const config: MCPConfigFile = {
        servers: Object.fromEntries(
            configs.map((c) => [
                c.name,
                {
                    transport: c.transport,
                    command: c.command,
                    args: c.args,
                    env: c.env,
                    url: c.url,
                    disabled: c.disabled,
                    authType: c.authType,
                    oauth: c.oauth
                }
            ])
        )
    };
    await saveMCPConfig(getConfigPath(), config);
}
