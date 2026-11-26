import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/http/middleware/error-handler';
import { createMCPRouter } from '@/http/routes/mcp';
import type { MCPServerConfig } from '@/modules/mcp';

const oauth = vi.hoisted(() => ({
    save: vi.fn(),
    getTokens: vi.fn(),
    clear: vi.fn(),
    pending: vi.fn(),
    setPending: vi.fn(),
    clearPending: vi.fn(),
    start: vi.fn(),
    complete: vi.fn(),
    resolve: vi.fn(),
    consume: vi.fn()
}));
vi.mock('@/modules/mcp', async () => ({
    ...(await vi.importActual('@/modules/mcp/catalog')),
    saveMCPConfig: oauth.save,
    tokenStore: { getTokens: oauth.getTokens, clear: oauth.clear },
    getPendingAuth: oauth.pending,
    setPendingAuth: oauth.setPending,
    clearPendingAuth: oauth.clearPending,
    startOAuthFlow: oauth.start,
    completeOAuthFlow: oauth.complete,
    resolveOAuthState: oauth.resolve,
    consumeOAuthState: oauth.consume
}));

let configs: MCPServerConfig[];
const manager = {
    getConfigs: vi.fn(() => configs),
    getAllStatus: vi.fn(),
    addServer: vi.fn(),
    updateServer: vi.fn(),
    removeServer: vi.fn(),
    reconnectServer: vi.fn(),
    disableServer: vi.fn(),
    getServerTools: vi.fn()
} satisfies NonNullable<ReturnType<Parameters<typeof createMCPRouter>[0]>>;
let ready = true;
const app = new Hono();
app.route(
    '/',
    createMCPRouter(
        () => (ready ? manager : undefined),
        () => '/fake/mcp.json'
    )
);
app.onError(errorHandler);
const stdio: MCPServerConfig = {
    name: 'local',
    transport: 'stdio',
    command: 'fake',
    args: ['arg'],
    env: { SAFE: 'value' }
};
const remote: MCPServerConfig = {
    name: 'remote',
    transport: 'sse',
    url: 'https://example.test/mcp',
    authType: 'oauth',
    oauth: { scope: 'read', clientId: 'client' }
};

async function req<T = unknown>(url: string, method = 'GET', body?: unknown, status = 200) {
    const response = await app.request(`/api/mcp/${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    expect(response.status).toBe(status);
    const result = (await response.json()) as { code: number; data?: T; message?: string };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result.data;
}
async function callback(query: string, contains: string) {
    const response = await app.request(`/api/mcp/oauth/callback${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain(contains);
}
beforeEach(() => {
    vi.resetAllMocks();
    configs = [{ ...stdio }, { ...remote }];
    ready = true;
    manager.getConfigs.mockImplementation(() => configs);
    manager.getAllStatus.mockResolvedValue([{ name: 'local', status: 'connected', toolCount: 2 }]);
    for (const fn of [manager.addServer, manager.updateServer, manager.reconnectServer])
        fn.mockResolvedValue({ name: 'local', ok: true });
    manager.getServerTools.mockResolvedValue([{ name: 'tool', description: 'desc' }]);
    oauth.resolve.mockReturnValue('remote');
    oauth.complete.mockResolvedValue(undefined);
    oauth.start.mockResolvedValue({ authenticated: true });
});

describe('MCP real HTTP routes', () => {
    it('returns 503 for every manager-dependent endpoint until initialized', async () => {
        ready = false;
        for (const [url, method] of [
            ['servers', 'GET'],
            ['servers', 'POST'],
            ['servers/local', 'PUT'],
            ['servers/local', 'DELETE'],
            ['servers/local/reconnect', 'POST'],
            ['servers/local/toggle', 'PATCH'],
            ['servers/local/tools', 'GET'],
            ['servers/local/auth', 'POST']
        ])
            await req(url!, method!, undefined, 503);
    });

    it('lists status/defaults and authentication flags without returning OAuth tokens', async () => {
        oauth.getTokens.mockReturnValue({ access_token: 'private-access-token' });
        const servers = await req<unknown[]>('servers');
        expect(servers).toHaveLength(2);
        expect(servers).toMatchObject([
            {
                name: 'local',
                status: 'connected',
                toolCount: 2,
                disabled: false,
                authenticated: true,
                authType: 'none'
            },
            { name: 'remote', status: 'disconnected', toolCount: 0, authType: 'oauth' }
        ]);
        expect(JSON.stringify(servers)).not.toContain('private-access-token');
        expect(await req('servers/local/tools')).toEqual([{ name: 'tool', description: 'desc' }]);
        expect(manager.getServerTools).toHaveBeenCalledWith('local');
    });

    it('validates add/update shapes, transport fields, duplicate/missing names and reports dependency errors', async () => {
        for (const method of ['POST', 'PUT']) {
            const url = method === 'POST' ? 'servers' : 'servers/local';
            for (const body of [
                {},
                { name: 'new', transport: 'bad' },
                { name: 'new', transport: 'sse' },
                { name: 'new', transport: 'streamableHttp' }
            ])
                await req(url, method, body, 400);
            const malformed = await app.request(`/api/mcp/${url}`, {
                method,
                headers: { 'content-type': 'application/json' },
                body: '{'
            });
            expect(malformed.status).toBe(500);
            expect(((await malformed.json()) as { code: number }).code).toBe(500);
        }
        await req('servers', 'POST', { name: 'new', transport: 'stdio' }, 400);
        await req('servers', 'POST', stdio, 409);
        await req('servers/local', 'PUT', remote, 409);
        await req('servers/missing', 'PUT', { name: 'new', transport: 'stdio', command: 'fake' }, 404);
        manager.addServer.mockRejectedValueOnce(new Error('manager failed'));
        await req('servers', 'POST', { name: 'new', transport: 'stdio', command: 'fake' }, 500);
        oauth.save.mockRejectedValueOnce(new Error('disk failed'));
        await req('servers', 'POST', { name: 'new', transport: 'stdio', command: 'fake' }, 500);
    });

    it('adds, renames, updates, removes and persists the exact manager snapshot', async () => {
        expect(
            await req('servers', 'POST', { name: 'new', transport: 'stdio', command: 'fake', disabled: true })
        ).toEqual({ name: 'new', status: 'connected' });
        expect(manager.addServer).toHaveBeenLastCalledWith(
            expect.objectContaining({ name: 'new', command: 'fake', disabled: true, authType: 'none' })
        );
        expect(oauth.save).toHaveBeenLastCalledWith('/fake/mcp.json', {
            servers: {
                local: { transport: 'stdio', command: 'fake', args: ['arg'], env: { SAFE: 'value' } },
                remote: { transport: 'sse', url: remote.url, authType: 'oauth', oauth: remote.oauth }
            }
        });
        manager.updateServer.mockResolvedValueOnce({ name: 'local', ok: false, error: 'offline' });
        expect(await req('servers/local', 'PUT', stdio)).toEqual({ name: 'local', status: 'failed', error: 'offline' });
        expect(manager.updateServer).toHaveBeenLastCalledWith('local', expect.objectContaining({ name: 'local' }));
        manager.addServer.mockResolvedValueOnce({ name: 'renamed', ok: false, error: 'offline' });
        expect(await req('servers/local', 'PUT', { ...stdio, name: 'renamed' })).toEqual({
            name: 'renamed',
            status: 'failed',
            error: 'offline'
        });
        expect(manager.removeServer).toHaveBeenLastCalledWith('local');
        expect(await req('servers/local', 'DELETE')).toEqual({ name: 'local', deleted: true });
        await req('servers/missing', 'DELETE', undefined, 404);
    });

    it('reconnects and toggles both directions with failed/connected results', async () => {
        expect(await req('servers/local/reconnect', 'POST')).toEqual({ name: 'local', status: 'connected' });
        manager.reconnectServer.mockResolvedValueOnce({ name: 'local', ok: false, error: 'down' });
        expect(await req('servers/local/reconnect', 'POST')).toEqual({
            name: 'local',
            status: 'failed',
            error: 'down'
        });
        expect(await req('servers/local/toggle', 'PATCH')).toEqual({
            name: 'local',
            disabled: true,
            status: 'connected'
        });
        expect(manager.disableServer).toHaveBeenCalledWith('local');
        configs[0]!.disabled = true;
        expect(await req('servers/local/toggle', 'PATCH')).toEqual({
            name: 'local',
            disabled: false,
            status: 'connected'
        });
        manager.updateServer.mockResolvedValueOnce({ name: 'local', ok: false, error: 'down' });
        expect(await req('servers/local/toggle', 'PATCH')).toMatchObject({ status: 'failed', error: 'down' });
        await req('servers/missing/toggle', 'PATCH', undefined, 404);
    });

    it('starts OAuth with saved metadata, tracks pending state and maps failures', async () => {
        await req('servers/missing/auth', 'POST', undefined, 404);
        await req('servers/local/auth', 'POST', undefined, 400);
        configs.push({ name: 'no-url', transport: 'stdio', authType: 'oauth' });
        await req('servers/no-url/auth', 'POST', undefined, 400);
        expect(await req('servers/remote/auth', 'POST')).toEqual({ authenticated: true });
        expect(oauth.start).toHaveBeenLastCalledWith(
            'remote',
            remote.url,
            expect.stringContaining('/api/mcp/oauth/callback'),
            expect.objectContaining({ client_name: '追寻 (remote)', scope: 'read' }),
            'read',
            'client'
        );
        oauth.start.mockResolvedValueOnce({ authorizationUrl: 'https://auth.test/start' });
        expect(await req('servers/remote/auth', 'POST')).toEqual({ authorizationUrl: 'https://auth.test/start' });
        expect(oauth.setPending).toHaveBeenCalledWith('remote', 'https://auth.test/start');
        oauth.start.mockResolvedValueOnce({});
        await req('servers/remote/auth', 'POST', undefined, 500);
        for (const error of [new Error('denied'), 'denied']) {
            oauth.start.mockRejectedValueOnce(error);
            await req('servers/remote/auth', 'POST', undefined, 500);
        }
        expect(await req('servers/remote/auth/status')).toEqual({ authenticated: false, pendingAuthorization: false });
        oauth.getTokens.mockReturnValue({ access_token: 'hidden-test-token' });
        oauth.pending.mockReturnValue({ completed: false, authorizationUrl: 'https://auth.test' });
        expect(await req('servers/remote/auth/status')).toEqual({
            authenticated: true,
            pendingAuthorization: true,
            authorizationUrl: 'https://auth.test'
        });
        oauth.pending.mockReturnValue({ completed: true, authorizationUrl: 'https://auth.test' });
        expect(await req('servers/remote/auth/status')).toEqual({ authenticated: true, pendingAuthorization: false });
        expect(await req('servers/remote/auth/revoke', 'POST')).toEqual({ revoked: true });
        expect(oauth.clear).toHaveBeenCalledWith('remote');
        expect(oauth.clearPending).toHaveBeenCalledWith('remote');
    });

    it('callback HTML escapes errors and enforces state, consumes only after successful token exchange', async () => {
        await callback('?error=%3Cscript%3E', '&lt;script&gt;');
        await callback('', '缺少授权码');
        oauth.resolve.mockReturnValueOnce(undefined);
        await callback('?code=code&state=bad', '无效的 state 参数');
        oauth.resolve.mockReturnValueOnce('missing');
        await callback('?code=code&state=state', '未找到服务: missing');
        ready = false;
        await callback('?code=code&state=state', '未找到服务: remote');
        ready = true;
        await callback('?code=code&state=state', '授权成功');
        expect(oauth.complete).toHaveBeenCalledWith('remote', 'code');
        expect(oauth.consume).toHaveBeenCalledWith('state');
        manager.reconnectServer.mockRejectedValueOnce(new Error('offline'));
        await callback('?code=code&state=state', '授权成功');
        await callback('?code=code', '授权成功');
        oauth.consume.mockClear();
        for (const error of [new Error('<secret>'), '<secret>']) {
            oauth.complete.mockRejectedValueOnce(error);
            await callback('?code=code&state=state', '&lt;secret&gt;');
        }
        expect(oauth.consume).not.toHaveBeenCalled();
    });
});

describe('内置应用连接', () => {
    it('返回应用目录，拒绝未知应用与非法凭证，不允许覆盖自定义服务', async () => {
        const catalog = await req<Array<{ id: string }>>('apps');
        expect(catalog?.map((app) => app.id)).toEqual(['baidu-netdisk', 'linear']);
        await req('apps/unknown/connect', 'POST', {}, 404);
        await req('apps/baidu-netdisk/connect', 'POST', {}, 400);
        await req('apps/baidu-netdisk/connect', 'POST', { token: 123 }, 400);
        configs.push({ name: 'app-linear', transport: 'sse', url: 'https://fixture.invalid' });
        await req('apps/linear/connect', 'POST', {}, 409);
        expect(manager.addServer).not.toHaveBeenCalled();
    });

    it('后端生成固定连接，持久化应用来源，列表与失败响应不返回令牌', async () => {
        const token = 'fixture-private-token';
        manager.addServer.mockImplementationOnce(async (config) => {
            configs.push(config);
            return { name: config.name, ok: false, error: config.url };
        });
        const result = await req('apps/baidu-netdisk/connect', 'POST', { token, url: 'https://untrusted.invalid' });
        expect(manager.addServer).toHaveBeenCalledWith(
            expect.objectContaining({
                connectorId: 'baidu-netdisk',
                transport: 'sse',
                url: 'https://mcp-pan.baidu.com/sse',
                headers: { Authorization: `Bearer ${token}` }
            })
        );
        expect(JSON.stringify(result)).not.toContain(token);
        expect(oauth.save).toHaveBeenCalledWith(
            '/fake/mcp.json',
            expect.objectContaining({
                servers: expect.objectContaining({
                    'app-baidu-netdisk': expect.objectContaining({ connectorId: 'baidu-netdisk' })
                })
            })
        );
        manager.getAllStatus.mockResolvedValueOnce([{ name: 'app-baidu-netdisk', status: 'failed', error: token }]);
        expect(JSON.stringify(await req('servers'))).not.toContain(token);
        await req(
            'servers/app-baidu-netdisk',
            'PUT',
            { name: 'app-baidu-netdisk', transport: 'sse', url: 'https://fixture.invalid' },
            400
        );
        await req('servers/app-baidu-netdisk', 'DELETE');
        expect(oauth.clear).toHaveBeenCalledWith('app-baidu-netdisk');
        expect(oauth.clearPending).toHaveBeenCalledWith('app-baidu-netdisk');
    });

    it('连接 OAuth 应用时不接受客户端端点或凭证配置，重新授权清除失效数据', async () => {
        await req('apps/linear/connect', 'POST', { url: 'https://untrusted.invalid' });
        expect(manager.addServer).toHaveBeenCalledWith({
            name: 'app-linear',
            connectorId: 'linear',
            transport: 'streamableHttp',
            authType: 'oauth',
            url: 'https://mcp.linear.app/mcp'
        });
        configs.push({
            name: 'app-linear',
            connectorId: 'linear',
            transport: 'streamableHttp',
            authType: 'oauth',
            url: 'https://mcp.linear.app/mcp'
        });
        await req('servers/app-linear/auth?force=1', 'POST');
        expect(oauth.clear).toHaveBeenCalledWith('app-linear');
    });
});

describe('MCP 自定义 Header 凭证', () => {
    it('校验请求头，不回显已保存值，空值更新保留旧凭证', async () => {
        await req(
            'servers',
            'POST',
            {
                name: 'bad',
                transport: 'sse',
                url: 'https://fixture.invalid',
                headers: { Authorization: 'x\r\nInjected: bad' }
            },
            400
        );
        configs.push({
            name: 'headers',
            transport: 'streamableHttp',
            url: 'https://fixture.invalid',
            headers: { Authorization: 'Bearer fixture-secret' }
        });
        const listed = await req<Array<{ name: string; headers?: Record<string, string> }>>('servers');
        expect(listed?.find((item) => item.name === 'headers')?.headers).toEqual({ Authorization: '' });
        await req('servers/headers', 'PUT', {
            name: 'headers',
            transport: 'streamableHttp',
            url: 'https://fixture.invalid',
            headers: { Authorization: '' }
        });
        expect(manager.updateServer).toHaveBeenCalledWith(
            'headers',
            expect.objectContaining({ headers: { Authorization: 'Bearer fixture-secret' } })
        );
        await req('servers/headers', 'PUT', {
            name: 'headers',
            transport: 'streamableHttp',
            url: 'https://fixture.invalid',
            headers: {}
        });
        expect(manager.updateServer).toHaveBeenLastCalledWith('headers', expect.objectContaining({ headers: {} }));
    });
});
