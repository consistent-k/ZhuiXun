import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnectorsRouter } from '@/http/routes/connectors';
import { CliConnectorService } from '@/modules/connectors';
import type { MCPServerConfig } from '@/modules/mcp';

import { createTempData } from '../helpers/temp-data';

const oauth = vi.hoisted(() => ({
    save: vi.fn(),
    pending: new Map<string, { authorizationUrl: string; completed: boolean }>(),
    clear: vi.fn(),
    flush: vi.fn(),
    start: vi.fn()
}));
vi.mock('@/modules/mcp', () => ({
    saveMCPConfig: oauth.save,
    getPendingAuth: (name: string) => oauth.pending.get(name),
    setPendingAuth: (name: string, authorizationUrl: string) =>
        oauth.pending.set(name, { authorizationUrl, completed: false }),
    clearPendingAuth: (name: string) => oauth.pending.delete(name),
    tokenStore: { clear: oauth.clear, flush: oauth.flush },
    startOAuthFlow: oauth.start
}));

describe('统一连接器 HTTP API', () => {
    let temp: Awaited<ReturnType<typeof createTempData>>;
    let cli: CliConnectorService;
    let configs: MCPServerConfig[];
    let app: Hono;
    let ready: boolean;
    let connected: boolean;
    const manager = {
        getConfigs: () => configs,
        getAllStatus: vi.fn(async () =>
            configs.map((item) => ({
                name: item.name,
                transport: item.transport,
                disabled: item.disabled ?? false,
                status: connected ? ('connected' as const) : ('failed' as const),
                toolCount: connected ? 2 : 0
            }))
        ),
        addServer: vi.fn(async (config: MCPServerConfig) => {
            configs.push(config);
            return { name: config.name, ok: connected };
        }),
        updateServer: vi.fn(async (name: string, config: MCPServerConfig) => {
            configs = configs.map((item) => (item.name === name ? config : item));
            return { name, ok: connected };
        }),
        removeServer: vi.fn(async (name: string) => {
            configs = configs.filter((item) => item.name !== name);
            return true;
        }),
        disableServer: vi.fn(async (name: string) => {
            configs.find((item) => item.name === name)!.disabled = true;
        })
    };
    beforeEach(async () => {
        vi.clearAllMocks();
        oauth.pending.clear();
        configs = [];
        ready = true;
        connected = true;
        temp = await createTempData('connector-http-');
        cli = new CliConnectorService(temp.root, undefined, vi.fn());
        app = new Hono().route(
            '/',
            createConnectorsRouter(
                () => (ready ? manager : undefined),
                () => '/fake/mcp.json',
                () => cli
            )
        );
    });
    afterEach(async () => {
        await cli.dispose();
        await temp.cleanup();
    });
    const request = async (path: string, body?: unknown, status = 200) => {
        const response = await app.request('/api/connectors/' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        expect(response.status).toBe(status);
        return (await response.json()) as { code: number; data: unknown };
    };
    it('目录暴露表单和类型，不包含命令和凭证，未就绪返回 503', async () => {
        const catalog = JSON.stringify(await request('apps'));
        expect(catalog).toContain('tencent-meeting');
        expect(catalog).toContain('fields');
        expect(catalog).not.toContain('loginArgs');
        expect(catalog).not.toContain('allowedCommands');
        ready = false;
        await request('connections', undefined, 503);
    });
    it('验证动态字段、固定服务端点，列表隐藏凭证，暂停和断开保持一致', async () => {
        await request('unknown/connect', {}, 404);
        await request('linear/install', {}, 400);
        await request('baidu-netdisk/connect', { values: [] }, 400);
        await request('baidu-netdisk/connect', { values: { token: 1 } }, 400);
        await request('baidu-netdisk/connect', { values: {} }, 400);
        await request('baidu-netdisk/connect', {
            values: { token: 'fixture-private' },
            url: 'https://untrusted.invalid'
        });
        expect(configs[0]?.headers).toEqual({ Authorization: 'Bearer fixture-private' });
        expect(configs[0]?.url).toBe('https://mcp-pan.baidu.com/sse');
        const state = JSON.stringify(await request('connections'));
        expect(state).not.toContain('fixture-private');
        expect(state).toContain('connected');
        await request('baidu-netdisk/disable', {});
        expect(configs[0]?.disabled).toBe(true);
        await request('baidu-netdisk/enable', {});
        expect(configs[0]?.disabled).toBe(false);
        await request('baidu-netdisk/disconnect', {});
        expect(configs).toHaveLength(0);
        expect(oauth.clear).toHaveBeenCalledWith('app-baidu-netdisk');
        expect(oauth.flush).toHaveBeenCalled();
    });
    it('兼容旧 URL token 配置，空表单重连不覆盖旧凭证；拒绝覆盖自定义服务', async () => {
        const legacy: MCPServerConfig = {
            name: 'app-baidu-netdisk',
            connectorId: 'baidu-netdisk',
            transport: 'sse',
            url: 'https://mcp-pan.baidu.com/sse?access_token=fixture-legacy'
        };
        configs.push(legacy);
        await request('baidu-netdisk/connect', {});
        expect(configs[0]?.url).toContain('fixture-legacy');
        configs = [{ name: 'app-linear', transport: 'stdio', command: 'fixture' }];
        await request('linear/connect', {}, 409);
    });
    it('OAuth 使用既有 SDK 授权编排，失败不会回显上游原始错误', async () => {
        connected = false;
        await request('linear/connect', {});
        oauth.start.mockResolvedValueOnce({ authorizationUrl: 'https://auth.invalid/authorize' });
        expect(JSON.stringify(await request('linear/auth', { force: true }))).toContain(
            'https://auth.invalid/authorize'
        );
        expect(oauth.clear).toHaveBeenCalledWith('app-linear');
        oauth.start.mockRejectedValueOnce(new Error('upstream-fixture-secret'));
        const response = await app.request('/api/connectors/linear/auth', { method: 'POST', body: '{}' });
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain('upstream-fixture-secret');
    });
    it('CLI 操作委托生命周期服务，客户端无法指定安装命令', async () => {
        const start = vi.spyOn(cli, 'start').mockResolvedValue({
            id: 'tencent-meeting',
            status: 'installing',
            enabled: true,
            configured: false,
            toolCount: 0
        });
        await request('tencent-meeting/install', { command: 'arbitrary-shell' });
        expect(start).toHaveBeenCalledWith('tencent-meeting', 'install');
        await request('tencent-meeting/connect', {});
        expect(start).toHaveBeenCalledWith('tencent-meeting', 'auth');
        start.mockRestore();
    });
});
