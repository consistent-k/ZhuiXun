import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => {
    const manager = {
        connectAll: vi.fn<() => Promise<void>>(),
        disconnectAll: vi.fn<() => Promise<void>>(),
        getStatus: vi.fn<() => 'ok' | 'degraded'>(),
        getResults: vi.fn<() => { name: string; ok: boolean; error?: string }[]>(),
        startHealthCheck: vi.fn(),
        getConfigs: vi.fn<() => { name: string; oauth?: { scopes: string[] } }[]>()
    };
    const registry = {
        scan: vi.fn<() => Promise<void>>(),
        listMetadata: vi.fn<() => { id: string }[]>()
    };
    return {
        manager,
        registry,
        managerConstructor: vi.fn(),
        registryConstructor: vi.fn(),
        config: { mcpServers: {} },
        configs: [{ name: 'demo', transport: 'stdio' }],
        loadConfig: vi.fn<() => Promise<unknown>>(),
        convertConfig: vi.fn(),
        setConfigResolver: vi.fn<(resolver: (name: string) => { oauth: unknown } | undefined) => void>(),
        ensureDir: vi.fn(),
        dangerous: vi.fn<() => boolean>(),
        prewarm: vi.fn(),
        registerChannels: vi.fn<() => Promise<void>>(),
        stopChannels: vi.fn<() => Promise<void>>(),
        buildRuntime: vi.fn(),
        createRunAgent: vi.fn(),
        channelRuntime: { name: 'fake-channel-runtime' },
        runAgent: vi.fn(),
        processMessage: vi.fn(),
        sleep: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    };
});

vi.mock('@zhuixun/channels-core', () => ({ processMessage: deps.processMessage, sleep: deps.sleep }));
vi.mock('@/agent/tools/windows-shell', () => ({ prewarmWindowsShell: deps.prewarm }));
vi.mock('@/config/danger-mode', () => ({ isDangerouslySkipPermissions: deps.dangerous }));
vi.mock('@/config/paths', () => ({
    ensureDirSafe: deps.ensureDir,
    paths: {
        mcpConfigPath: () => '/virtual/bootstrap-services/.mcp.json',
        skillsDir: () => '/virtual/bootstrap-services/skills',
        externalSkillDirs: () => ['/virtual/external/skills', '/virtual/external']
    }
}));
vi.mock('@/modules/channels', () => ({
    channelManager: { stopAll: deps.stopChannels },
    buildChannelRuntime: deps.buildRuntime,
    registerChannels: deps.registerChannels
}));
vi.mock('@/modules/chat/agents/runner', () => ({
    createChannelRunAgent: deps.createRunAgent,
    createAutomationRunAgent: vi.fn(() => vi.fn())
}));
vi.mock('@/modules/conversations', () => ({ getConversationStore: vi.fn(() => ({})) }));
vi.mock('@/modules/chat', () => ({
    configureBackgroundTurns: vi.fn(),
    sessionEvents: { emit: vi.fn() },
    sessionRuntime: {
        setStarter: vi.fn(),
        deliver: vi.fn(),
        onIdle: vi.fn(() => () => {}),
        isBusy: vi.fn(() => false)
    },
    startBackgroundTurn: vi.fn(),
    subscribeSessionEvents: vi.fn(() => () => {})
}));
vi.mock('@/modules/jobs', () => ({
    createJobService: () => ({ recover: vi.fn().mockResolvedValue(undefined) }),
    setJobService: vi.fn()
}));
vi.mock('@/modules/goal', () => ({
    GoalService: class {
        start(): void {}
        dispose(): void {}
    },
    setGoalService: vi.fn()
}));
vi.mock('@/modules/automation', () => ({
    createScheduler: () => ({
        start: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
        requestReschedule: vi.fn()
    }),
    getAutomationStore: vi.fn()
}));
vi.mock('@/modules/mcp', () => ({
    MCPClientManager: class {
        constructor(configs: unknown) {
            deps.managerConstructor(configs);
            return deps.manager;
        }
    },
    loadMCPConfig: deps.loadConfig,
    mcpConfigToServerConfigs: deps.convertConfig,
    setConfigResolver: deps.setConfigResolver
}));
vi.mock('@/modules/skills', () => ({
    SkillRegistry: class {
        constructor(...args: unknown[]) {
            deps.registryConstructor(...args);
            return deps.registry;
        }
    }
}));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => deps.log }));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    // 每例重新导入真实组合根，隔离其 container/shutdownPromise，不让上例状态伪造幂等性。
    vi.resetModules();
    for (const mock of [
        ...Object.values(deps.manager),
        ...Object.values(deps.registry),
        ...Object.values(deps.log),
        deps.managerConstructor,
        deps.registryConstructor,
        deps.loadConfig,
        deps.convertConfig,
        deps.setConfigResolver,
        deps.ensureDir,
        deps.dangerous,
        deps.prewarm,
        deps.registerChannels,
        deps.stopChannels,
        deps.buildRuntime,
        deps.createRunAgent
    ]) {
        mock.mockReset();
    }
    deps.manager.connectAll.mockResolvedValue(undefined);
    deps.manager.disconnectAll.mockResolvedValue(undefined);
    deps.manager.getStatus.mockReturnValue('ok');
    deps.manager.getResults.mockReturnValue([]);
    deps.manager.getConfigs.mockReturnValue([{ name: 'demo', oauth: { scopes: ['read'] } }, { name: 'no-oauth' }]);
    deps.registry.scan.mockResolvedValue(undefined);
    deps.registry.listMetadata.mockReturnValue([{ id: 'one' }, { id: 'two' }]);
    deps.loadConfig.mockResolvedValue(deps.config);
    deps.convertConfig.mockReturnValue(deps.configs);
    deps.dangerous.mockReturnValue(false);
    deps.registerChannels.mockResolvedValue(undefined);
    deps.stopChannels.mockResolvedValue(undefined);
    deps.buildRuntime.mockReturnValue(deps.channelRuntime);
    deps.createRunAgent.mockReturnValue(deps.runAgent);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('bootstrap services composition', () => {
    it('publishes an isolated ready container without awaiting background MCP connections', async () => {
        const connecting = deferred();
        deps.manager.connectAll.mockReturnValue(connecting.promise);
        deps.dangerous.mockReturnValue(true);
        const { getContainer, initializeServices } = await import('@/bootstrap/services');
        expect(getContainer()).toBeUndefined();

        const container = await initializeServices();
        expect(getContainer()).toBe(container);
        expect(container.registry).toBe(deps.registry);
        expect(container.mcp).toBe(deps.manager);
        expect(container.mcpConfigPath).toBe('/virtual/bootstrap-services/.mcp.json');
        expect(container.runtime).toMatchObject({
            ready: true,
            mcp: 'unknown',
            skills: 2,
            dangerSkipPermissions: true
        });
        expect(container.runtime.startedAt).toEqual(expect.any(String));
        expect(deps.ensureDir.mock.calls).toEqual([
            [path.dirname(container.mcpConfigPath), 'mcp-config'],
            ['/virtual/bootstrap-services/skills', 'user-skills']
        ]);
        expect(deps.loadConfig).toHaveBeenCalledWith(container.mcpConfigPath);
        expect(deps.convertConfig).toHaveBeenCalledWith(deps.config);
        expect(deps.managerConstructor).toHaveBeenCalledWith(deps.configs);
        expect(deps.registryConstructor).toHaveBeenCalledWith(deps.manager, '/virtual/bootstrap-services/skills', [
            '/virtual/external/skills',
            '/virtual/external'
        ]);
        expect(deps.registry.scan).toHaveBeenCalledOnce();
        expect(deps.prewarm).toHaveBeenCalledOnce();
        expect(deps.manager.startHealthCheck).not.toHaveBeenCalled();
        expect(deps.createRunAgent).toHaveBeenCalledWith(deps.registry);
        expect(deps.registerChannels).toHaveBeenCalledWith(
            {
                runAgent: deps.runAgent,
                runtime: deps.channelRuntime,
                processMessage: deps.processMessage,
                sleep: deps.sleep
            },
            undefined
        );

        const resolver = deps.setConfigResolver.mock.calls[0]![0];
        expect(resolver('demo')).toEqual({ oauth: { scopes: ['read'] } });
        expect(resolver('no-oauth')).toEqual({ oauth: undefined });
        expect(resolver('missing')).toBeUndefined();

        connecting.resolve();
        await connecting.promise;
        expect(container.runtime.mcp).toBe('ok');
        expect(container.runtime.mcpError).toBeUndefined();
        expect(deps.manager.startHealthCheck).toHaveBeenCalledWith(60_000);
        await expect((await import('@/bootstrap/services')).shutdownServices()).resolves.toBeUndefined();
    });

    it('records partial MCP failures and starts health checks instead of rejecting initialization', async () => {
        deps.manager.getStatus.mockReturnValue('degraded');
        deps.manager.getResults.mockReturnValue([
            { name: 'healthy', ok: true },
            { name: 'offline', ok: false, error: 'connection refused' },
            { name: 'auth', ok: false, error: 'token missing' }
        ]);
        deps.registry.listMetadata.mockReturnValue([]);
        const { initializeServices } = await import('@/bootstrap/services');
        const { runtime } = await initializeServices();
        expect(runtime).toMatchObject({
            ready: true,
            skills: 0,
            dangerSkipPermissions: false,
            mcp: 'degraded',
            mcpError: 'offline: connection refused; auth: token missing'
        });
        expect(deps.manager.startHealthCheck).toHaveBeenCalledWith(60_000);
        expect(deps.log.warn).toHaveBeenCalledWith('MCP 降级运行', {
            failedCount: 2,
            detail: runtime.mcpError
        });
    });

    it.each([new Error('MCP startup failed'), 'MCP startup failed'])(
        'records background connection rejection (%s) without rejecting the container',
        async (error) => {
            deps.manager.connectAll.mockRejectedValue(error);
            const { initializeServices } = await import('@/bootstrap/services');
            const { runtime } = await initializeServices();
            // connectAll 的 catch 位于 then 之后，再排一次微任务才能观察完成态。
            await Promise.resolve();
            expect(runtime).toMatchObject({ ready: true, mcp: 'failed', mcpError: 'MCP startup failed' });
            expect(deps.manager.startHealthCheck).not.toHaveBeenCalled();
            expect(deps.log.error).toHaveBeenCalledWith('MCP 异步连接失败', { err: error });
        }
    );

    it('degrades channel registration independently while still publishing the container and OAuth resolver', async () => {
        const error = new Error('channel unavailable');
        deps.registerChannels.mockRejectedValue(error);
        const { getContainer, initializeServices } = await import('@/bootstrap/services');
        const container = await initializeServices();
        expect(getContainer()).toBe(container);
        expect(container.runtime.ready).toBe(true);
        expect(deps.setConfigResolver).toHaveBeenCalledOnce();
        expect(deps.log.error).toHaveBeenCalledWith('渠道注册失败（不影响其余服务）', { err: error });
    });

    it.each([false, true])(
        'disconnects a partially initialized manager on scan failure (cleanup rejects: %s)',
        async (fail) => {
            const scanError = new Error('invalid skill root');
            deps.registry.scan.mockRejectedValue(scanError);
            if (fail) deps.manager.disconnectAll.mockRejectedValue(new Error('disconnect failed'));
            const { getContainer, initializeServices } = await import('@/bootstrap/services');
            await expect(initializeServices()).rejects.toBe(scanError);
            expect(deps.manager.disconnectAll).toHaveBeenCalledOnce();
            expect(getContainer()).toBeUndefined();
            expect(deps.manager.connectAll).not.toHaveBeenCalled();
            expect(deps.prewarm).not.toHaveBeenCalled();
            expect(deps.registerChannels).not.toHaveBeenCalled();
            expect(deps.setConfigResolver).not.toHaveBeenCalled();
        }
    );

    it('propagates config loading failure before allocating a manager or publishing state', async () => {
        const error = new Error('config is unreadable');
        deps.loadConfig.mockRejectedValue(error);
        const { getContainer, initializeServices } = await import('@/bootstrap/services');
        await expect(initializeServices()).rejects.toBe(error);
        expect(getContainer()).toBeUndefined();
        expect(deps.managerConstructor).not.toHaveBeenCalled();
        expect(deps.registryConstructor).not.toHaveBeenCalled();
        expect(deps.manager.disconnectAll).not.toHaveBeenCalled();
    });
});

describe('bootstrap service shutdown', () => {
    it('can stop before initialization and shares a single pending cleanup across concurrent/repeated calls', async () => {
        const stopping = deferred();
        deps.stopChannels.mockReturnValue(stopping.promise);
        const { shutdownServices } = await import('@/bootstrap/services');
        const first = shutdownServices();
        const second = shutdownServices();
        expect(deps.stopChannels).toHaveBeenCalledOnce();
        expect(deps.manager.disconnectAll).not.toHaveBeenCalled();
        stopping.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        await shutdownServices();
        expect(deps.stopChannels).toHaveBeenCalledOnce();
    });

    it('starts both cleanup tasks concurrently and absorbs individual failures without skipping the other', async () => {
        const disconnecting = deferred();
        const stopping = deferred();
        deps.manager.disconnectAll.mockReturnValue(disconnecting.promise);
        deps.stopChannels.mockReturnValue(
            stopping.promise.then(() => Promise.reject(new Error('channel stop failed')))
        );
        const { initializeServices, shutdownServices } = await import('@/bootstrap/services');
        await initializeServices();
        let completed = false;
        const first = shutdownServices().then(() => {
            completed = true;
        });
        const second = shutdownServices();
        expect(deps.manager.disconnectAll).toHaveBeenCalledOnce();
        expect(deps.stopChannels).toHaveBeenCalledOnce();
        stopping.resolve();
        await Promise.resolve();
        expect(completed).toBe(false);
        disconnecting.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        await shutdownServices();
        expect(deps.manager.disconnectAll).toHaveBeenCalledOnce();
        expect(deps.stopChannels).toHaveBeenCalledOnce();
    });

    it('still stops channels when disconnect rejects', async () => {
        deps.manager.disconnectAll.mockRejectedValue(new Error('MCP disconnect failed'));
        const { initializeServices, shutdownServices } = await import('@/bootstrap/services');
        await initializeServices();
        await expect(shutdownServices()).resolves.toBeUndefined();
        expect(deps.manager.disconnectAll).toHaveBeenCalledOnce();
        expect(deps.stopChannels).toHaveBeenCalledOnce();
    });
});
