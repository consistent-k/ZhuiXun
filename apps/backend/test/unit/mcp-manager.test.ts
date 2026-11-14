import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MCPClient, MCPClientManager, MCPServerConfig } from '@/modules/mcp/manager';

const sdk = vi.hoisted(() => ({
    createClient: vi.fn(),
    stdio: vi.fn(),
    sse: vi.fn(),
    http: vi.fn(),
    execFile: vi.fn()
}));

// 只替换 SDK/transport 边界，manager 的连接、状态、计时器与 CRUD 均执行真实实现。
vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: sdk.createClient }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: sdk.stdio
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: sdk.sse }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: sdk.http
}));
vi.mock('node:child_process', () => ({ execFile: sdk.execFile }));

function client() {
    return {
        listTools: vi.fn().mockResolvedValue({
            tools: [{ name: 'lookup', description: 'fixture', inputSchema: { type: 'object' } }]
        }),
        close: vi.fn().mockResolvedValue(undefined)
    };
}

type FakeClient = ReturnType<typeof client>;
let root: string;
let Manager: typeof MCPClientManager;
let managers: MCPClientManager[];
let clients: FakeClient[];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const remote = (name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
    name,
    transport: 'sse',
    url: 'https://fixture.invalid/mcp',
    ...extra
});
function manager(configs: MCPServerConfig[] = []) {
    const m = new Manager(configs);
    managers.push(m);
    return m;
}

beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manager-'));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    // 必须在加载 config/paths 前隔离 HOME；不依赖宿主真实 .agents / OAuth / nvm。
    for (const [key, value] of Object.entries({
        HOME: root,
        USERPROFILE: root,
        NODE_ENV: 'test',
        LOG_DIR: path.join(root, 'logs'),
        SETTINGS_CONFIG_PATH: path.join(root, 'settings.json'),
        MCP_CONFIG_PATH: path.join(root, 'mcp.json'),
        MCP_OAUTH_PATH: path.join(root, 'oauth.json'),
        SKILLS_USER_DIR: path.join(root, 'skills'),
        SKILLS_EXTERNAL_DIRS: path.join(root, 'external'),
        CHANNELS_USER_DIR: path.join(root, 'channels'),
        SESSIONS_USER_DIR: path.join(root, 'sessions'),
        STREAMS_USER_DIR: path.join(root, 'streams'),
        MEMORY_USER_DIR: path.join(root, 'memory'),
        PERMISSION_USER_DIR: path.join(root, 'permission'),
        PROJECTS_USER_DIR: path.join(root, 'projects'),
        TASKS_USER_DIR: path.join(root, 'tasks'),
        ZHUIXUN_BACKEND_RESOURCES: path.join(root, 'resources')
    }))
        vi.stubEnv(key, value);
    sdk.stdio.mockImplementation(function (options) {
        return { kind: 'stdio', options, pid: 12345 };
    });
    sdk.sse.mockImplementation(function (url, options) {
        return { kind: 'sse', url, options };
    });
    sdk.http.mockImplementation(function (url, options) {
        return { kind: 'streamableHttp', url, options };
    });
    clients = [];
    sdk.createClient.mockImplementation(async () => {
        const c = client();
        clients.push(c);
        return c as unknown as MCPClient;
    });
    sdk.execFile.mockImplementation((_command, _args, callback) => callback(null));
    managers = [];
    ({ MCPClientManager: Manager } = await import('@/modules/mcp/manager'));
    vi.useFakeTimers();
});

afterEach(async () => {
    for (const m of managers) await m.disconnectAll();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', originalPlatform);
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
});

describe('MCP manager connections and process isolation', () => {
    it('connects all three transports, skips disabled and isolates failure per server', async () => {
        const m = manager([
            { name: 'stdio', transport: 'stdio', command: 'node', args: ['fixture.js'] },
            remote('sse', { authType: 'oauth' }),
            remote('http', { transport: 'streamableHttp' }),
            remote('bad', { url: 'not a URL' }),
            remote('off', { disabled: true })
        ]);
        const result = await m.connectAll();
        expect(result).toEqual([
            { name: 'stdio', ok: true },
            { name: 'sse', ok: true },
            { name: 'http', ok: true },
            { name: 'bad', ok: false, error: expect.any(String) }
        ]);
        expect(m.getResults()).toEqual(result);
        expect(m.getConnectedServers()).toEqual(['stdio', 'sse', 'http']);
        expect(m.getClient('sse')).toBe(clients[1]);
        expect(m.getClient('missing')).toBeUndefined();
        expect(m.getStatus()).toBe('degraded');
        expect(sdk.stdio.mock.calls[0][0]).toMatchObject({
            command: process.execPath,
            args: ['fixture.js'],
            env: { ELECTRON_RUN_AS_NODE: '1' }
        });
        expect(sdk.sse.mock.calls[0][0].href).toBe('https://fixture.invalid/mcp');
        expect(sdk.sse.mock.calls[0][1].authProvider.serverName).toBe('sse');
        expect(sdk.http.mock.calls[0][1]).toEqual({ authProvider: undefined });
        const onError = sdk.createClient.mock.calls[0][0].onUncaughtError;
        expect(() => onError(new Error('fixture transport error'))).not.toThrow();
        expect(await m.getAllStatus()).toMatchObject([
            { name: 'stdio', status: 'connected', toolCount: 1, disabled: false },
            { name: 'sse', status: 'connected' },
            { name: 'http', status: 'connected' },
            { name: 'bad', status: 'failed', toolCount: 0 },
            { name: 'off', status: 'disconnected', disabled: true }
        ]);
    });

    it('reports no servers, all failures, success and disconnected configurations', async () => {
        expect(manager().getStatus()).toBe('ok');
        const m = manager([remote('one')]);
        expect(await m.getAllStatus()).toMatchObject([{ status: 'disconnected' }]);
        sdk.createClient.mockRejectedValueOnce('non-Error failure');
        expect(await m.connectAll()).toEqual([{ name: 'one', ok: false, error: 'non-Error failure' }]);
        expect(m.getStatus()).toBe('failed');
        expect(await m.reconnectServer('one')).toEqual({ name: 'one', ok: true });
        expect(m.getStatus()).toBe('ok');
    });

    it('passes only safe environment plus explicit overrides and fills Finder PATH', async () => {
        await fs.mkdir(path.join(root, '.nvm/versions/node/v24/bin'), { recursive: true });
        await fs.mkdir(path.join(root, '.nvm/versions/node/v26/bin'), { recursive: true });
        vi.stubEnv('PATH', `/fixture/bin${path.delimiter}/fixture/bin`);
        vi.stubEnv('LC_ALL', 'en_US.UTF-8');
        vi.stubEnv('BACKEND_PRIVATE_FIXTURE', 'must-not-leak');
        const m = manager();
        await m.addServer({ name: 'python', transport: 'stdio', command: 'python', env: { PUBLIC: 'yes' } });
        const opts = sdk.stdio.mock.calls[0][0];
        expect(opts.command).toBe('python');
        expect(opts.env.LC_ALL).toBe('en_US.UTF-8');
        expect(opts.env.PUBLIC).toBe('yes');
        expect(opts.env.BACKEND_PRIVATE_FIXTURE).toBeUndefined();
        expect(opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        const paths = opts.env.PATH.split(path.delimiter);
        expect(paths[0]).toBe(path.dirname(process.execPath));
        expect(paths).toContain('/fixture/bin');
        expect(paths).toContain('/usr/bin');
        expect(paths.indexOf(path.join(root, '.nvm/versions/node/v26/bin'))).toBeLessThan(
            paths.indexOf(path.join(root, '.nvm/versions/node/v24/bin'))
        );
        expect(new Set(paths).size).toBe(paths.length);
        await m.addServer({ name: 'custom', transport: 'stdio', command: '/fixture/node', env: { PATH: '/only' } });
        expect(sdk.stdio.mock.calls[1][0].env.PATH).toBe('/only');
    });

    it('reuses internal node and bundled npx on runtime reconnect too', async () => {
        const resources = process.env.ZHUIXUN_BACKEND_RESOURCES!;
        const cli = path.join(resources, 'npm/bin/npx-cli.js');
        await fs.mkdir(path.dirname(cli), { recursive: true });
        await fs.writeFile(cli, '// inert fixture, never executed');
        const m = manager([{ name: 'node', transport: 'stdio', command: 'node.exe' }]);
        await m.connectAll();
        await m.reconnectServer('node');
        await m.addServer({ name: 'npx', transport: 'stdio', command: 'npx', args: ['-y', 'fixture'] });
        await m.addServer({ name: 'cmd', transport: 'stdio', command: 'npx.cmd' });
        expect(sdk.stdio.mock.calls.map(([opts]) => opts)).toMatchObject([
            { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
            { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
            { command: process.execPath, args: [cli, '-y', 'fixture'], env: { ELECTRON_RUN_AS_NODE: '1' } },
            { command: process.execPath, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } }
        ]);
        expect(clients[0].close).toHaveBeenCalledOnce();
        expect(sdk.execFile).not.toHaveBeenCalled();
    });

    it('falls back to npx when not bundled, caching the negative lookup', async () => {
        const m = manager();
        await m.addServer({ name: 'first', transport: 'stdio', command: 'npx', args: ['fixture'] });
        const cli = path.join(process.env.ZHUIXUN_BACKEND_RESOURCES!, 'npm/bin/npx-cli.js');
        await fs.mkdir(path.dirname(cli), { recursive: true });
        await fs.writeFile(cli, '// inert');
        await m.addServer({ name: 'cached', transport: 'stdio', command: 'npx.cmd' });
        expect(sdk.stdio.mock.calls[0][0]).toMatchObject({ command: 'npx', args: ['fixture'] });
        expect(sdk.stdio.mock.calls[1][0].command).toBe('npx.cmd');
    });

    it('closes clients concurrently, tolerates failure and Windows taskkill is fake', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const m = manager();
        await m.addServer({ name: 'stdio', transport: 'stdio', command: 'node' });
        await m.addServer(remote('sse'));
        clients[0].close.mockRejectedValueOnce(new Error('already closed'));
        sdk.execFile.mockImplementationOnce((_cmd, _args, cb) => cb(new Error('not running')));
        await m.disconnectAll();
        expect(sdk.execFile).toHaveBeenCalledWith('taskkill', ['/PID', '12345', '/T', '/F'], expect.any(Function));
        expect(clients.every((c) => c.close.mock.calls.length === 1)).toBe(true);
        expect(m.getConnectedServers()).toEqual([]);
        expect(m.getClient('stdio')).toBeUndefined();
    });
});

describe('MCP manager tools and CRUD', () => {
    it('lists tools and treats absent clients or failed list calls as empty', async () => {
        const m = manager();
        expect(await m.getServerTools('missing')).toEqual([]);
        await m.addServer(remote('one'));
        expect(await m.getServerTools('one')).toEqual([
            { name: 'lookup', description: 'fixture', inputSchema: { type: 'object' } }
        ]);
        clients[0].listTools.mockRejectedValueOnce(new Error('offline'));
        expect(await m.getServerTools('one')).toEqual([]);
        clients[0].listTools.mockRejectedValueOnce('offline');
        expect(await m.getAllStatus()).toMatchObject([{ status: 'connected', toolCount: 0 }]);
    });

    it('adds, updates in place, appends unknown, disables, reconnects and removes', async () => {
        const initial = [remote('one'), remote('two')];
        const m = manager(initial);
        initial.pop();
        expect(m.getConfigs()).toHaveLength(2);
        const copied = m.getConfigs();
        copied.pop();
        expect(m.getConfigs()).toHaveLength(2);
        await m.connectAll();
        const first = clients[0];
        first.close.mockRejectedValueOnce(new Error('closed'));
        expect(await m.updateServer('one', remote('renamed', { transport: 'streamableHttp' }))).toEqual({
            name: 'renamed',
            ok: true
        });
        expect(first.close).toHaveBeenCalledOnce();
        expect(m.getConfigs().map((c) => c.name)).toEqual(['renamed', 'two']);
        expect(m.getClient('one')).toBeUndefined();
        await m.updateServer('new', remote('new'));
        expect(m.getConfigs().map((c) => c.name)).toEqual(['renamed', 'two', 'new']);
        clients[1].close.mockRejectedValueOnce('closed');
        await m.disableServer('two');
        expect(m.getConfigs()[1].disabled).toBe(true);
        expect(await m.getAllStatus()).toMatchObject([
            { name: 'renamed', status: 'connected' },
            { name: 'two', status: 'disconnected', disabled: true, error: 'Disabled' },
            { name: 'new', status: 'connected' }
        ]);
        const calls = sdk.createClient.mock.calls.length;
        expect(await m.addServer(remote('off', { disabled: true }))).toEqual({
            name: 'off',
            ok: false,
            error: 'Disabled'
        });
        expect(sdk.createClient).toHaveBeenCalledTimes(calls);
        expect(await m.reconnectServer('absent')).toEqual({
            name: 'absent',
            ok: false,
            error: 'Server "absent" not found in configs'
        });
        const current = m.getClient('renamed') as unknown as FakeClient;
        current.close.mockRejectedValueOnce('closed');
        await m.reconnectServer('renamed');
        expect(current.close).toHaveBeenCalledOnce();
        const removing = m.getClient('new') as unknown as FakeClient;
        removing.close.mockRejectedValueOnce('closed');
        expect(await m.removeServer('new')).toBe(true);
        expect(removing.close).toHaveBeenCalledOnce();
        expect(await m.removeServer('missing')).toBe(true);
        await m.disableServer('missing');
        expect(m.getConnectedServers()).toEqual(['renamed']);
        expect(m.getConfigs().map((c) => c.name)).toEqual(['renamed', 'two', 'off']);
    });
});

describe('MCP manager health checks, backoff and timer ownership', () => {
    it('probes sequentially and does not overlap slow checks; stopping suppresses the next tick', async () => {
        const m = manager([remote('one')]);
        await m.connectAll();
        let release!: (value: { tools: [] }) => void;
        clients[0].listTools.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );
        m.startHealthCheck(100);
        await vi.advanceTimersByTimeAsync(100);
        expect(clients[0].listTools).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1000);
        expect(clients[0].listTools).toHaveBeenCalledOnce();
        m.stopHealthCheck();
        release({ tools: [] });
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('replaces an existing health timer and runs default interval probes', async () => {
        const m = manager([remote('one')]);
        await m.connectAll();
        m.startHealthCheck(50);
        m.startHealthCheck();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(clients[0].listTools).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(clients[0].listTools).toHaveBeenCalledOnce();
        m.stopHealthCheck();
        m.stopHealthCheck();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('marks disconnected on probe failure and retries at 1s then 2s before recovering', async () => {
        const m = manager([remote('one')]);
        await m.connectAll();
        const old = clients[0];
        old.listTools.mockRejectedValueOnce(new Error('lost'));
        old.close.mockRejectedValueOnce(new Error('closed'));
        sdk.createClient.mockRejectedValueOnce(new Error('retry failed'));
        m.startHealthCheck(100);
        await vi.advanceTimersByTimeAsync(100);
        m.stopHealthCheck();
        expect(old.close).toHaveBeenCalledOnce();
        expect(m.getConnectedServers()).toEqual([]);
        expect(m.getStatus()).toBe('failed');
        expect(await m.getAllStatus()).toMatchObject([{ status: 'reconnecting', error: 'lost' }]);
        await vi.advanceTimersByTimeAsync(999);
        expect(sdk.createClient).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sdk.createClient).toHaveBeenCalledTimes(2);
        expect(m.getResults()).toEqual([{ name: 'one', ok: false, error: 'retry failed' }]);
        await vi.advanceTimersByTimeAsync(1999);
        expect(sdk.createClient).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(m.getResults()).toEqual([{ name: 'one', ok: true }]);
        expect(m.getStatus()).toBe('ok');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('caps exponential delay at 30s, gives up after eight retries and permits manual retry', async () => {
        const m = manager([remote('one')]);
        await m.connectAll();
        clients[0].listTools.mockRejectedValueOnce('lost');
        sdk.createClient.mockRejectedValue('still down');
        m.startHealthCheck(10);
        await vi.advanceTimersByTimeAsync(10);
        m.stopHealthCheck();
        expect(m.getResults()[0].error).toBe('Health check failed');
        const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
        for (const [index, delay] of delays.entries()) {
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(sdk.createClient).toHaveBeenCalledTimes(index + 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(sdk.createClient).toHaveBeenCalledTimes(index + 2);
        }
        expect(vi.getTimerCount()).toBe(0);
        expect(await m.getAllStatus()).toMatchObject([{ status: 'failed', error: 'still down' }]);
        sdk.createClient.mockImplementation(async () => client());
        expect(await m.reconnectServer('one')).toEqual({ name: 'one', ok: true });
    });

    it.each(['disable', 'remove', 'disconnect', 'update', 'manual'] as const)(
        'cancels a pending reconnect on %s',
        async (action) => {
            const m = manager([remote('one')]);
            await m.connectAll();
            clients[0].listTools.mockRejectedValueOnce(new Error('lost'));
            m.startHealthCheck(10);
            await vi.advanceTimersByTimeAsync(10);
            m.stopHealthCheck();
            expect(vi.getTimerCount()).toBe(1);
            if (action === 'disable') await m.disableServer('one');
            if (action === 'remove') await m.removeServer('one');
            if (action === 'disconnect') await m.disconnectAll();
            if (action === 'update') await m.updateServer('one', remote('renamed'));
            if (action === 'manual') await m.reconnectServer('one');
            const calls = sdk.createClient.mock.calls.length;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(sdk.createClient).toHaveBeenCalledTimes(calls);
            expect(vi.getTimerCount()).toBe(0);
        }
    );
});
