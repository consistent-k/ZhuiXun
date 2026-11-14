import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { oauthCallbackUrl } from '@/config/server';
import { createLogger } from '@/platform/logging/index';

import { MCPOAuthProvider } from './oauth';

const log = createLogger('MCP');

/** 透出 AI SDK 的 MCP 客户端类型，供 adapter 等消费方按需引用 */
export type { MCPClient };

/**
 * 解析给 stdio MCP 子进程用的 PATH，缓存一次。
 *
 * 为什么需要：桌面端从 Finder 拉起时，进程 PATH 往往只有 `/usr/bin:/bin`，
 * 既没有 nvm/homebrew 的 node，也没有 npx —— stdio server 配成 `command: node/npx`
 * 就会 `spawn node ENOENT`。开发/网页版从终端起，PATH 正常，所以只在打包形态下才会暴露。
 * （裸 `node`/`npx` 已在 resolveStdioLaunch 里改走内部 Electron 二进制 + ELECTRON_RUN_AS_NODE，
 * 这里补 PATH 主要兜底「其余外部命令」如绝对路径/python 等。）
 *
 * 关键：**纯文件系统拼装，绝不 spawn shell**。早期版本用 `$SHELL -lic` 取用户真实 PATH，
 * 但交互式登录 shell 会 source 用户 rc（.zshrc 等），可能触发 iTerm/Terminal 之类 GUI 副作用
 * ——实测导致状态栏终端一直跳动、无法退出。现改为直接扫已知目录。
 *
 * 策略（去重，靠前优先）：
 * 1. 当前进程可执行文件所在目录（`process.execPath` 的目录）；
 * 2. nvm 各版本 bin（新版本靠前）—— 用户常用 nvm，`npx`/`node` 都在这；
 * 3. `~/.local/bin` + homebrew + 当前进程 PATH + 系统标准目录兜底。
 */
let cachedStdioPath: string | null = null;
function resolveStdioPath(): string {
    if (cachedStdioPath !== null) return cachedStdioPath;
    const parts: string[] = [];
    const seen = new Set<string>();
    const add = (p?: string): void => {
        if (p && !seen.has(p)) {
            seen.add(p);
            parts.push(p);
        }
    };

    add(path.dirname(process.execPath));

    if (process.platform !== 'win32') {
        const nvmRoot = path.join(os.homedir(), '.nvm/versions/node');
        try {
            // 新版本排前面，让 npx/node 优先命中较新版本；纯 readdir，不起子进程
            for (const v of fs.readdirSync(nvmRoot).sort().reverse()) {
                add(path.join(nvmRoot, v, 'bin'));
            }
        } catch {
            /* 没装 nvm，忽略 */
        }
        add(path.join(os.homedir(), '.local/bin'));
        ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'].forEach(add);
    }

    for (const p of (process.env.PATH || '').split(path.delimiter)) add(p);

    if (process.platform !== 'win32') {
        ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].forEach(add);
    }

    cachedStdioPath = parts.join(path.delimiter);
    return cachedStdioPath;
}

/**
 * 定位随包分发的 npm 的 npx-cli.js（打包时经 electron-builder extraResources 放到 resources/backend/npm）。
 * 找到就能用内部 node（Electron + ELECTRON_RUN_AS_NODE）跑 npx，不依赖本机 node/npx。
 * 找不到（如 dev，或未随包 npm）返回 undefined，回落本机 npx。
 * 两个来源：Electron 主进程注入的 ZHUIXUN_BACKEND_RESOURCES，以及 server.js 自身所在目录。
 */
let npxCliResolved = false;
let npxCliPath: string | undefined;
function bundledNpxCli(): string | undefined {
    if (npxCliResolved) return npxCliPath;
    npxCliResolved = true;
    const candidates: string[] = [];
    if (process.env.ZHUIXUN_BACKEND_RESOURCES) {
        candidates.push(path.join(process.env.ZHUIXUN_BACKEND_RESOURCES, 'npm', 'bin', 'npx-cli.js'));
    }
    try {
        candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), 'npm', 'bin', 'npx-cli.js'));
    } catch {
        /* import.meta.url 不可用时忽略 */
    }
    npxCliPath = candidates.find((c) => fs.existsSync(c));
    return npxCliPath;
}

interface StdioLaunch {
    command: string;
    args?: string[];
    /**
     * 该启动是否复用「内部 node」(`process.execPath`)。为 true 时调用方须给子进程 env 注入
     * `ELECTRON_RUN_AS_NODE=1`：Electron 形态下 `process.execPath` 是 Electron 可执行文件，
     * 不加该变量会把参数当 Electron 启动而非 node；纯 node 形态(dev/tsx)下该变量被忽略，无副作用。
     */
    usesInternalNode?: boolean;
}

/**
 * 把 .mcp.json 的 command/args 解析成实际启动参数，尽量用宿主自带的内部 node：
 * - 裸 `node` → 内部 node（`process.execPath`），彻底规避打包形态 `spawn node ENOENT`；
 * - 裸 `npx`  → 内部 node + 随包 npm 的 npx-cli.js（打包形态）；dev/未随包时回落本机 `npx`；
 * - 其余（绝对路径 / python 等）→ 原样，靠 resolveStdioPath 补好的 PATH 解析。
 */
function resolveStdioLaunch(command: string, args?: string[]): StdioLaunch {
    if (command === 'node' || command === 'node.exe') {
        return { command: process.execPath, args, usesInternalNode: true };
    }
    if (command === 'npx' || command === 'npx.cmd') {
        const cli = bundledNpxCli();
        if (cli) return { command: process.execPath, args: [cli, ...(args ?? [])], usesInternalNode: true };
    }
    return { command, args };
}

/**
 * stdio 子进程只透传必要的系统环境变量 + 该 server 显式声明的 env，
 * 不再把整个 process.env（含 MODEL_API_KEY 等后端密钥）暴露给每个 MCP 子进程。
 * 需要额外变量的 server 应在 .mcp.json 的 env 里显式声明。
 */
const SAFE_ENV_KEYS = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'TERM',
    'TZ',
    'TMPDIR',
    'NODE_PATH',
    // Windows 常用
    'SystemRoot',
    'SystemDrive',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PATHEXT',
    'ComSpec',
    'windir'
];

function buildStdioEnv(configEnv?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {};
    for (const key of SAFE_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) base[key] = value;
    }
    // 透传本地化相关 LC_* 变量
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('LC_') && value !== undefined) base[key] = value;
    }
    // 用补全后的 PATH 覆盖进程 PATH：打包端从 Finder 起时进程 PATH 太窄，会导致
    // stdio server 的 node/npx 找不到（spawn ENOENT）。configEnv 显式声明的仍可覆盖。
    base.PATH = resolveStdioPath();
    return { ...base, ...(configEnv || {}) };
}

export interface MCPServerConfig {
    name: string;
    transport: 'stdio' | 'sse' | 'streamableHttp';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    disabled?: boolean;
    authType?: 'none' | 'oauth';
    oauth?: {
        scope?: string;
        clientId?: string;
        clientSecret?: string;
    };
}

export interface MCPConnectResult {
    name: string;
    ok: boolean;
    error?: string;
}

export interface MCPServerStatus {
    name: string;
    transport: 'stdio' | 'sse' | 'streamableHttp';
    status: 'connected' | 'failed' | 'disconnected' | 'reconnecting';
    error?: string;
    toolCount: number;
    disabled: boolean;
}

export class MCPClientManager {
    private clients = new Map<string, MCPClient>();
    /**
     * stdio 传输句柄（server name → transport）。保留引用只为在关闭时拿到子进程 pid 做
     * Windows 进程树兜底清理：stdio server 配成裸 `node`/`npx` 时走内部 Electron 二进制
     * (ELECTRON_RUN_AS_NODE)，子进程名即 `追寻.exe`；若退出时不终止，会残留无窗口的
     * `追寻.exe` 后台进程，使 NSIS 安装器误判「应用仍在运行」而拒绝覆盖安装。
     * sse/streamableHttp 无子进程，不入表。
     */
    private stdioTransports = new Map<string, StdioClientTransport>();
    private results: MCPConnectResult[] = [];
    private configs: MCPServerConfig[];
    private healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
    private healthCheckActive = false;
    /** 在途自动重连：server name → { attempts, timer }，用于指数退避与并发保护 */
    private reconnecting = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> }>();
    /** 自动重连退避参数 */
    private static readonly RECONNECT_BASE_MS = 1_000;
    private static readonly RECONNECT_MAX_MS = 30_000;
    private static readonly RECONNECT_MAX_ATTEMPTS = 8;

    constructor(configs: MCPServerConfig[]) {
        this.configs = [...configs];
    }

    /** 连接全部 MCP 服务，返回逐台结果（失败不抛，由调用方决定是否降级） */
    async connectAll(): Promise<MCPConnectResult[]> {
        this.results = [];

        for (const config of this.configs) {
            if (config.disabled) {
                log.info('跳过（已禁用）', { server: config.name });
                continue;
            }
            // 首次连接与运行时重连必须走同一路径，否则 Electron node 环境和 stdio 退出句柄会漂移。
            await this.connectOne(config);
        }

        return this.results;
    }

    getResults(): MCPConnectResult[] {
        return this.results;
    }

    /**
     * 汇总连接状态：
     * - 没有配置任何服务 → ok（本来就不期待连接）
     * - 全部成功 → ok
     * - 部分成功 → degraded
     * - 全部失败 → failed
     */
    getStatus(): 'ok' | 'degraded' | 'failed' {
        if (this.results.length === 0) return 'ok';

        const failed = this.results.filter((r) => !r.ok);
        if (failed.length === 0) return 'ok';
        if (failed.length === this.results.length) return 'failed';
        return 'degraded';
    }

    getClient(serverName: string): MCPClient | undefined {
        return this.clients.get(serverName);
    }

    /** 获取所有已连接的服务器名称 */
    getConnectedServers(): string[] {
        return Array.from(this.clients.keys());
    }

    /** 获取指定服务器的所有工具列表 */
    async getServerTools(
        serverName: string
    ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
        const client = this.clients.get(serverName);
        if (!client) {
            log.warn('服务未连接', { server: serverName });
            return [];
        }

        try {
            const result = await client.listTools();
            return result.tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema
            }));
        } catch (error) {
            log.error('列出工具失败', { server: serverName, err: error });
            return [];
        }
    }

    async disconnectAll(): Promise<void> {
        this.stopHealthCheck();
        for (const name of [...this.reconnecting.keys()]) this.cancelReconnect(name);
        // 并行关闭：SDK 的 stdio close() 最坏要走「等 stdin 关闭 2s → SIGTERM 2s → SIGKILL」，
        // 串行累加会轻松超过宿主的退出兜底窗口；并行后整体≈单台最慢的一台。allSettled 保证
        // 任一台抛错不中断其余。
        await Promise.allSettled([...this.clients].map(([name, client]) => this.closeOne(name, client)));
        this.clients.clear();
        this.stdioTransports.clear();
    }

    /** 关闭单台连接：取 pid → Windows 强制终止进程树（兜底孙进程）→ client.close()（清理传输状态）。 */
    private async closeOne(name: string, client: MCPClient): Promise<void> {
        // 关闭前先取 stdio 子进程 pid：client.close() 成功后 transport._process 会被置空、pid 读不到。
        const pid = this.stdioTransports.get(name)?.pid ?? undefined;
        // Windows 兜底：client.close() 只 kill 直属子进程，npx 这类会再派生孙进程
        // (node → 实际 server，均为 ELECTRON_RUN_AS_NODE 的 追寻.exe)，父进程被终止后孙进程
        // 会变孤儿残留、被 NSIS 安装器误判应用在运行。taskkill /T 连整棵树一起终止；且进程被强制终止后
        // 其 'close' 事件会立即触发，使 client.close() 内的优雅等待立刻返回，不必空耗到 4s。
        await Promise.allSettled([
            this.killProcessTreeOnWindows(pid, name),
            client.close().catch((error) => log.warn('关闭失败', { server: name, err: error }))
        ]);
    }

    /**
     * 仅 Windows：按 pid 强制终止整棵进程树（taskkill /T /F）。非 Windows / 无 pid 直接返回。
     * 永不抛错——清理尽力而为，失败只告警（进程可能已随 client.close() 正常退出）。
     */
    private killProcessTreeOnWindows(pid: number | undefined, serverName: string): Promise<void> {
        if (process.platform !== 'win32' || !pid) return Promise.resolve();
        return new Promise<void>((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (error) => {
                // 非 0 退出常见于进程已不存在（已被正常终止），属正常情况，debug 即可。
                if (error) log.debug('taskkill 进程树（可能已退出）', { server: serverName, pid, err: error.message });
                resolve();
            });
        });
    }

    /**
     * 启动定期健康检查。
     * 每隔 intervalMs 对所有已连接的 server 调用 ping，失败则标记为 disconnected 并从 clients 中移除。
     *
     * 用递归 setTimeout 而非 setInterval(async …)：后者在单次 ping 慢于 intervalMs 时会让多个 tick
     * 交叠执行，并在 await 间隙修改正被遍历的 clients。递归 setTimeout 保证「上一轮跑完再排下一轮」。
     */
    startHealthCheck(intervalMs = 60_000): void {
        this.stopHealthCheck();
        this.healthCheckActive = true;

        const tick = async () => {
            // 遍历快照：await 期间可能删改 clients
            for (const [name, client] of [...this.clients]) {
                try {
                    // AI SDK 的轻量 MCP 客户端没有 ping；用一次 listTools 作为存活探针
                    await client.listTools();
                } catch (error) {
                    log.warn('健康检查失败，断开连接并尝试自动重连', {
                        server: name,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    try {
                        await client.close();
                    } catch {
                        // 忽略关闭错误
                    }
                    this.clients.delete(name);
                    this.stdioTransports.delete(name);
                    // 更新 results 状态
                    const existing = this.results.find((r) => r.name === name);
                    if (existing) {
                        existing.ok = false;
                        existing.error = error instanceof Error ? error.message : 'Health check failed';
                    }
                    // 指数退避自动重连（禁用的 server 不重连）
                    this.scheduleReconnect(name);
                }
            }
            // 上一轮结束后再排下一轮（stopHealthCheck 会把 active 置 false 终止循环）
            if (this.healthCheckActive) {
                this.healthCheckTimer = setTimeout(tick, intervalMs);
            }
        };

        this.healthCheckTimer = setTimeout(tick, intervalMs);
    }

    /** 停止定期健康检查 */
    stopHealthCheck(): void {
        this.healthCheckActive = false;
        if (this.healthCheckTimer) {
            clearTimeout(this.healthCheckTimer);
            this.healthCheckTimer = undefined;
        }
    }

    /**
     * 为掉线的 server 安排一次指数退避自动重连。
     * - 同一 server 同时只有一个重连循环（并发保护）。
     * - 禁用 / 已不在配置中的 server 不重连。
     * - 成功即清空重连状态；达最大次数后放弃，保留 failed 状态与手动重连入口。
     */
    private scheduleReconnect(name: string): void {
        const config = this.configs.find((c) => c.name === name);
        if (!config || config.disabled) return;
        if (this.reconnecting.has(name)) return; // 已有在途重连循环

        const attempt = (attempts: number): void => {
            const delay = Math.min(
                MCPClientManager.RECONNECT_BASE_MS * 2 ** attempts,
                MCPClientManager.RECONNECT_MAX_MS
            );
            const timer = setTimeout(async () => {
                // 期间可能被禁用/移除
                const cur = this.configs.find((c) => c.name === name);
                if (!cur || cur.disabled) {
                    this.reconnecting.delete(name);
                    return;
                }
                log.info('自动重连中', { server: name, attempt: attempts + 1 });
                this.results = this.results.filter((r) => r.name !== name);
                const result = await this.connectOne(cur);
                if (result.ok) {
                    this.reconnecting.delete(name);
                    log.info('自动重连成功', { server: name });
                    return;
                }
                const nextAttempts = attempts + 1;
                if (nextAttempts >= MCPClientManager.RECONNECT_MAX_ATTEMPTS) {
                    this.reconnecting.delete(name);
                    log.warn('自动重连达最大次数，放弃（可手动重连）', { server: name });
                    return;
                }
                attempt(nextAttempts);
            }, delay);
            this.reconnecting.set(name, { attempts, timer });
        };

        attempt(0);
    }

    /** 取消某 server 在途的自动重连（禁用/移除/手动重连时调用） */
    private cancelReconnect(name: string): void {
        const entry = this.reconnecting.get(name);
        if (entry) {
            clearTimeout(entry.timer);
            this.reconnecting.delete(name);
        }
    }

    /** 获取当前所有配置（含内存中的） */
    getConfigs(): MCPServerConfig[] {
        return [...this.configs];
    }

    /** 运行时添加一个 server 并连接（disabled 的 server 只注册不连接） */
    async addServer(config: MCPServerConfig): Promise<MCPConnectResult> {
        this.configs.push(config);
        if (config.disabled) {
            this.results.push({ name: config.name, ok: false, error: 'Disabled' });
            return { name: config.name, ok: false, error: 'Disabled' };
        }
        const result = await this.connectOne(config);
        return result;
    }

    /** 运行时移除一个 server 并断开连接 */
    async removeServer(name: string): Promise<boolean> {
        this.cancelReconnect(name);
        const client = this.clients.get(name);
        if (client) {
            await client.close().catch(() => {});
            this.clients.delete(name);
            this.stdioTransports.delete(name);
        }
        this.configs = this.configs.filter((c) => c.name !== name);
        this.results = this.results.filter((r) => r.name !== name);
        return true;
    }

    /** 运行时更新一个 server 配置（断开旧的 → 更新 → 重连）；原位置替换，保持列表顺序稳定 */
    async updateServer(name: string, config: MCPServerConfig): Promise<MCPConnectResult> {
        this.cancelReconnect(name);
        const oldClient = this.clients.get(name);
        if (oldClient) {
            await oldClient.close().catch(() => {});
            this.clients.delete(name);
            this.stdioTransports.delete(name);
        }
        // 原位置更新配置（找不到则追加）
        const idx = this.configs.findIndex((c) => c.name === name);
        if (idx >= 0) {
            this.configs[idx] = config;
        } else {
            this.configs.push(config);
        }
        this.results = this.results.filter((r) => r.name !== name);
        return this.connectOne(config);
    }

    /** 运行时禁用一个 server：断开连接但保留配置（原位置），保持列表顺序稳定 */
    async disableServer(name: string): Promise<void> {
        this.cancelReconnect(name);
        const client = this.clients.get(name);
        if (client) {
            await client.close().catch(() => {});
            this.clients.delete(name);
            this.stdioTransports.delete(name);
        }
        const idx = this.configs.findIndex((c) => c.name === name);
        if (idx >= 0) {
            this.configs[idx] = { ...this.configs[idx], disabled: true };
        }
        this.results = this.results.filter((r) => r.name !== name);
        this.results.push({ name, ok: false, error: 'Disabled' });
    }

    /** 手动重连指定 server */
    async reconnectServer(name: string): Promise<MCPConnectResult> {
        this.cancelReconnect(name);
        const config = this.configs.find((c) => c.name === name);
        if (!config) {
            return { name, ok: false, error: `Server "${name}" not found in configs` };
        }
        const oldClient = this.clients.get(name);
        if (oldClient) {
            await oldClient.close().catch(() => {});
            this.clients.delete(name);
            this.stdioTransports.delete(name);
        }
        this.results = this.results.filter((r) => r.name !== name);
        return this.connectOne(config);
    }

    /** 获取所有 server 的运行时状态 */
    async getAllStatus(): Promise<MCPServerStatus[]> {
        const statuses: MCPServerStatus[] = [];
        for (const config of this.configs) {
            const client = this.clients.get(config.name);
            let toolCount = 0;
            if (client) {
                try {
                    const result = await client.listTools();
                    toolCount = result.tools.length;
                } catch {
                    // 忽略工具列表获取失败
                }
            }
            const result = this.results.find((r) => r.name === config.name);
            statuses.push({
                name: config.name,
                transport: config.transport,
                status: config.disabled
                    ? 'disconnected'
                    : client
                      ? 'connected'
                      : this.reconnecting.has(config.name)
                        ? 'reconnecting'
                        : result && !result.ok
                          ? 'failed'
                          : 'disconnected',
                error: result?.error,
                toolCount,
                disabled: !!config.disabled
            });
        }
        return statuses;
    }

    /** 连接单个 server 的内部方法 */
    private async connectOne(config: MCPServerConfig): Promise<MCPConnectResult> {
        try {
            const needsAuth = config.authType === 'oauth';
            const authProvider = needsAuth
                ? new MCPOAuthProvider(config.name, oauthCallbackUrl(), {
                      redirect_uris: [oauthCallbackUrl()],
                      client_name: `追寻 (${config.name})`,
                      grant_types: ['authorization_code'],
                      response_types: ['code']
                  })
                : undefined;

            let transport;
            if (config.transport === 'stdio') {
                const launch = resolveStdioLaunch(config.command!, config.args);
                const stdioEnv = buildStdioEnv(config.env);
                // 重连同样复用 Electron 内部 node；漏掉此变量会把脚本当 Electron 应用启动。
                if (launch.usesInternalNode) stdioEnv.ELECTRON_RUN_AS_NODE = '1';
                transport = new StdioClientTransport({
                    command: launch.command,
                    args: launch.args,
                    env: stdioEnv
                });
                this.stdioTransports.set(config.name, transport);
            } else if (config.transport === 'sse') {
                // 旧 SSE 通过 endpoint 事件协商 POST 地址，与 Streamable HTTP 握手不同，保留已有服务兼容。
                transport = new SSEClientTransport(new URL(config.url!), { authProvider });
            } else {
                transport = new StreamableHTTPClientTransport(new URL(config.url!), {
                    authProvider
                });
            }

            const client = (await createMCPClient({
                transport,
                onUncaughtError: (error) => log.warn('MCP 客户端未捕获错误', { server: config.name, err: error })
            })) as MCPClient;

            this.clients.set(config.name, client);
            this.results.push({ name: config.name, ok: true });
            log.info('已连接', { server: config.name });
            return { name: config.name, ok: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.results.push({ name: config.name, ok: false, error: message });
            log.error('连接失败', { server: config.name, error: message });
            if (error instanceof Error && error.stack) {
                log.debug('连接失败堆栈', { server: config.name, stack: error.stack });
            }
            return { name: config.name, ok: false, error: message };
        }
    }
}
