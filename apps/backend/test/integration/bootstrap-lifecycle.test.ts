import { EventEmitter } from 'node:events';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
    serve: vi.fn(),
    fetch: vi.fn(),
    cleanupStreams: vi.fn<() => Promise<void>>(),
    flushLogs: vi.fn<() => Promise<void>>(),
    scan: vi.fn<() => Promise<void>>(),
    connect: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn<() => Promise<void>>(),
    stopChannels: vi.fn<() => Promise<void>>(),
    registerChannels: vi.fn<() => Promise<void>>(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

// app 只是 lifecycle 的 fetch 依赖；services 与 lifecycle 两个被测模块始终加载真实实现。
vi.mock('@/bootstrap/instance', () => ({
    claimBackendInstance: async () => ({ publish: async () => {}, release: async () => {} })
}));
vi.mock('@/bootstrap/app', () => ({ default: { fetch: deps.fetch } }));
vi.mock('@hono/node-server', () => ({ serve: deps.serve }));
vi.mock('@zhuixun/channels-core', () => ({ processMessage: vi.fn(), sleep: vi.fn() }));
vi.mock('@/agent/tools/windows-shell', () => ({ prewarmWindowsShell: vi.fn() }));
vi.mock('@/config/danger-mode', () => ({ isDangerouslySkipPermissions: () => false }));
vi.mock('@/config/paths', () => ({
    ensureDirSafe: vi.fn(),
    paths: {
        mcpConfigPath: () => '/virtual/bootstrap-lifecycle/.mcp.json',
        skillsDir: () => '/virtual/bootstrap-lifecycle/skills',
        externalSkillDirs: () => []
    }
}));
vi.mock('@/modules/chat', () => ({
    cleanupStaleStreamFiles: deps.cleanupStreams,
    desktopApprovalGrants: { grant: vi.fn(), revoke: vi.fn(), clear: vi.fn() },
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
vi.mock('@/modules/chat/agents/runner', () => ({
    createChannelRunAgent: vi.fn(),
    createAutomationRunAgent: vi.fn(() => vi.fn())
}));
vi.mock('@/modules/conversations', () => ({ getConversationStore: vi.fn(() => ({})) }));
vi.mock('@/modules/automation', () => ({
    createScheduler: () => ({
        start: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
        requestReschedule: vi.fn()
    }),
    getAutomationStore: vi.fn()
}));
vi.mock('@/modules/channels', () => ({
    channelManager: { stopAll: deps.stopChannels },
    buildChannelRuntime: vi.fn(),
    registerChannels: deps.registerChannels
}));
vi.mock('@/modules/mcp', () => ({
    loadMCPConfig: async () => ({ mcpServers: {} }),
    mcpConfigToServerConfigs: () => [],
    setConfigResolver: vi.fn(),
    MCPClientManager: class {
        connectAll = deps.connect;
        disconnectAll = deps.disconnect;
        getStatus = () => 'ok';
        getResults = () => [];
        startHealthCheck = vi.fn();
    }
}));
vi.mock('@/modules/skills', () => ({
    SkillRegistry: class {
        scan = deps.scan;
        listMetadata = () => [];
    }
}));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => deps.log, flushLogs: deps.flushLogs }));

interface ServeOptions {
    fetch: unknown;
    port: number;
    hostname: string;
}

type Listening = (info: { address: string; port: number }) => void;

class ProbeServer extends EventEmitter {
    listen = vi.fn((candidate: number, host: string) => {
        probed.push({ candidate, host });
        const free = available.shift() ?? true;
        queueMicrotask(() => {
            if (free) this.emit('listening');
            else this.emit('error', Object.assign(new Error('probe unavailable'), { code: 'EADDRINUSE' }));
        });
        return this;
    });

    close = vi.fn((done: () => void) => {
        done();
        return this;
    });
}

class HttpServer extends EventEmitter {
    close = vi.fn((done: () => void) => {
        done();
        return this;
    });
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

let available: boolean[];
let probed: { candidate: number; host: string }[];
let probes: ProbeServer[];
let httpServer: HttpServer;
let restorePort: () => void;

beforeEach(() => {
    // setup 已封锁真实 I/O；只在其后覆盖 createServer，serve 则全程是模块级 fake。
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const originalPort = process.env.PORT;
    restorePort = () => {
        if (originalPort === undefined) delete process.env.PORT;
        else process.env.PORT = originalPort;
    };
    process.env.PORT = '31001';
    available = [];
    probed = [];
    probes = [];
    httpServer = new HttpServer();
    for (const mock of [
        deps.serve,
        deps.cleanupStreams,
        deps.flushLogs,
        deps.scan,
        deps.connect,
        deps.disconnect,
        deps.stopChannels,
        deps.registerChannels,
        ...Object.values(deps.log)
    ]) {
        mock.mockReset();
    }
    deps.cleanupStreams.mockResolvedValue(undefined);
    deps.flushLogs.mockResolvedValue(undefined);
    deps.scan.mockResolvedValue(undefined);
    deps.connect.mockResolvedValue(undefined);
    deps.disconnect.mockResolvedValue(undefined);
    deps.stopChannels.mockResolvedValue(undefined);
    deps.registerChannels.mockResolvedValue(undefined);
    vi.spyOn(net, 'createServer').mockImplementation(() => {
        const probe = new ProbeServer();
        probes.push(probe);
        return probe as unknown as net.Server;
    });
    // 真正监听的回调异步触发，避免同步 fake 误踩 serve 返回前 instance 尚未赋值的 TDZ。
    deps.serve.mockImplementation((options: ServeOptions, listening: Listening) => {
        queueMicrotask(() => listening({ address: options.hostname, port: options.port }));
        return httpServer;
    });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restorePort();
});

describe('bootstrap lifecycle port discovery', () => {
    it('probes and serves only 127.0.0.1, then writes the actual port before service initialization', async () => {
        available = [false, false, true];
        deps.scan.mockImplementation(async () => {
            expect(process.env.PORT).toBe('31003');
        });
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        expect(probed).toEqual([
            { candidate: 31001, host: '127.0.0.1' },
            { candidate: 31002, host: '127.0.0.1' },
            { candidate: 31003, host: '127.0.0.1' }
        ]);
        expect(probes.map((probe) => probe.close.mock.calls.length)).toEqual([0, 0, 1]);
        expect(deps.serve).toHaveBeenCalledWith(
            { fetch: deps.fetch, port: 31003, hostname: '127.0.0.1' },
            expect.any(Function)
        );
        expect(running.port).toBe(31003);
        expect(process.env.PORT).toBe('31003');
        expect(deps.log.warn).toHaveBeenCalledWith('端口 31001 被占用，已自动切换到空闲端口 31003');
        expect(deps.cleanupStreams).toHaveBeenCalledOnce();
        await running.close();
    });

    it('uses the configured default without a misleading occupied-port warning', async () => {
        delete process.env.PORT;
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        expect(running.port).toBe(31001);
        expect(probed).toEqual([{ candidate: 31001, host: '127.0.0.1' }]);
        expect(deps.log.warn).not.toHaveBeenCalled();
        await running.close();
    });

    it('can choose the twentieth candidate, not only the first nineteen', async () => {
        available = [...Array<boolean>(19).fill(false), true];
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        expect(running.port).toBe(31020);
        expect(probed).toHaveLength(20);
        await running.close();
    });

    it('rejects after exactly twenty busy probes without initializing services or starting HTTP', async () => {
        available = Array<boolean>(21).fill(false);
        const { startServer } = await import('@/bootstrap/lifecycle');
        await expect(startServer()).rejects.toThrow('从端口 31001 起连续 20 个端口均被占用');
        expect(probed.map(({ candidate }) => candidate)).toEqual(
            Array.from({ length: 20 }, (_, index) => 31001 + index)
        );
        expect(deps.scan).not.toHaveBeenCalled();
        expect(deps.serve).not.toHaveBeenCalled();
        expect(process.env.PORT).toBe('31001');
    });

    it('can choose 65535 but never probes past the valid port range', async () => {
        process.env.PORT = '65534';
        available = [false, true];
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        expect(probed.map(({ candidate }) => candidate)).toEqual([65534, 65535]);
        expect(running.port).toBe(65535);
        await running.close();
    });

    it.each(['65535', '65536'])('stops at the upper boundary for starting port %s', async (start) => {
        process.env.PORT = start;
        available = [false, false];
        const { startServer } = await import('@/bootstrap/lifecycle');
        await expect(startServer()).rejects.toThrow(`从端口 ${start} 起连续 20 个端口均被占用`);
        expect(probed.map(({ candidate }) => candidate)).toEqual(start === '65535' ? [65535] : []);
        expect(deps.serve).not.toHaveBeenCalled();
        expect(deps.scan).not.toHaveBeenCalled();
    });
});

describe('bootstrap lifecycle startup and runtime failures', () => {
    it('still listens after a real services initialization failure, leaving the container unavailable', async () => {
        const error = new Error('registry scan failed');
        deps.scan.mockRejectedValue(error);
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        const { getContainer } = await import('@/bootstrap/services');
        expect(getContainer()).toBeUndefined();
        expect(deps.disconnect).toHaveBeenCalledOnce();
        expect(deps.serve).toHaveBeenCalledOnce();
        expect(deps.log.error).toHaveBeenCalledWith('服务初始化失败，将以不可用状态启动（/health 返回 503）', {
            err: error
        });
        await running.close();
        expect(deps.stopChannels).toHaveBeenCalledOnce();
    });

    it('warns on orphan stream cleanup failure without blocking HTTP startup', async () => {
        const error = new Error('stream directory unavailable');
        deps.cleanupStreams.mockRejectedValue(error);
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        expect(deps.log.warn).toHaveBeenCalledWith('清理残留流文件失败', { err: error });
        await running.close();
    });

    it('does not await background stream cleanup to start serving', async () => {
        const cleanup = deferred();
        deps.cleanupStreams.mockReturnValue(cleanup.promise);
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        expect(deps.serve).toHaveBeenCalledOnce();
        cleanup.resolve();
        await running.close();
    });

    it.each(['EADDRINUSE', 'EACCES'])(
        'rejects pre-listening %s errors rather than treating them as runtime errors',
        async (code) => {
            const error = Object.assign(new Error('listen failed'), { code });
            deps.serve.mockImplementation(() => {
                queueMicrotask(() => httpServer.emit('error', error));
                return httpServer;
            });
            const { startServer } = await import('@/bootstrap/lifecycle');
            const starting = startServer();
            if (code === 'EADDRINUSE') {
                await expect(starting).rejects.toThrow('端口 31001 已被占用，可能有残留进程');
            } else {
                await expect(starting).rejects.toBe(error);
            }
            expect(deps.log.error).not.toHaveBeenCalledWith('HTTP 服务运行期错误', expect.anything());
        }
    );

    it('propagates a synchronous serve failure', async () => {
        const error = new Error('adapter creation failed');
        deps.serve.mockImplementation(() => {
            throw error;
        });
        const { startServer } = await import('@/bootstrap/lifecycle');
        await expect(startServer()).rejects.toBe(error);
    });

    it('logs post-listening server errors while keeping the running handle closeable', async () => {
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        const error = Object.assign(new Error('socket error'), { code: 'EADDRINUSE' });
        expect(httpServer.emit('error', error)).toBe(true);
        expect(deps.log.error).toHaveBeenCalledWith('HTTP 服务运行期错误', { err: error });
        await running.close();
    });
});

describe('bootstrap lifecycle close', () => {
    it('awaits service cleanup before HTTP close, then awaits log flushing', async () => {
        const disconnecting = deferred();
        const flushing = deferred();
        deps.disconnect.mockReturnValue(disconnecting.promise);
        deps.flushLogs.mockReturnValue(flushing.promise);
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        let completed = false;
        const closing = running.close().then(() => {
            completed = true;
        });
        expect(deps.disconnect).toHaveBeenCalledOnce();
        expect(deps.stopChannels).toHaveBeenCalledOnce();
        expect(httpServer.close).not.toHaveBeenCalled();
        disconnecting.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(httpServer.close).toHaveBeenCalledOnce();
        expect(deps.flushLogs).toHaveBeenCalledOnce();
        expect(completed).toBe(false);
        flushing.resolve();
        await closing;
        expect(completed).toBe(true);
        expect(deps.disconnect.mock.invocationCallOrder[0]).toBeLessThan(httpServer.close.mock.invocationCallOrder[0]!);
        expect(httpServer.close.mock.invocationCallOrder[0]).toBeLessThan(deps.flushLogs.mock.invocationCallOrder[0]!);
    });

    it('still closes HTTP after individual shutdown tasks reject', async () => {
        deps.disconnect.mockRejectedValue(new Error('disconnect failed'));
        deps.stopChannels.mockRejectedValue(new Error('stop failed'));
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        await expect(running.close()).resolves.toBeUndefined();
        expect(httpServer.close).toHaveBeenCalledOnce();
        expect(deps.flushLogs).toHaveBeenCalledOnce();
    });

    it('resolves if the HTTP close method throws rather than hanging or rejecting', async () => {
        httpServer.close.mockImplementation(() => {
            throw new Error('close failed');
        });
        const { startServer } = await import('@/bootstrap/lifecycle');
        const running = await startServer();
        await expect(running.close()).resolves.toBeUndefined();
        expect(deps.flushLogs).not.toHaveBeenCalled();
    });

    it.each(['services', 'http', 'logs'])(
        'unblocks exactly at the five-second fallback when %s hangs',
        async (stage) => {
            const pending = deferred();
            if (stage === 'services') deps.disconnect.mockReturnValue(pending.promise);
            if (stage === 'http') httpServer.close.mockImplementation(() => httpServer);
            if (stage === 'logs') deps.flushLogs.mockReturnValue(pending.promise);
            const { startServer } = await import('@/bootstrap/lifecycle');
            const running = await startServer();
            let completed = false;
            const closing = running.close().then(() => {
                completed = true;
            });
            await vi.advanceTimersByTimeAsync(4999);
            expect(completed).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(closing).resolves.toBeUndefined();
            expect(completed).toBe(true);
            if (stage === 'services') expect(httpServer.close).not.toHaveBeenCalled();
            else expect(httpServer.close).toHaveBeenCalledOnce();
            if (stage === 'http') expect(deps.flushLogs).not.toHaveBeenCalled();
            pending.resolve();
            await vi.advanceTimersByTimeAsync(0);
        }
    );
});
