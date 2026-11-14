import net from 'node:net';

import { serve } from '@hono/node-server';

import { HOST, port } from '@/config/server';
import { cleanupStaleStreamFiles, desktopApprovalGrants } from '@/modules/chat';
import { createLogger, flushLogs } from '@/platform/logging/index';

import app from './app';
import { claimBackendInstance } from './instance';
import { getContainer, initializeServices, shutdownServices } from './services';

const log = createLogger('Boot');

/** 运行中的后端句柄：供宿主（Electron 主进程 / standalone 入口）优雅关闭。 */
export interface RunningBackend {
    /** 实际监听端口（配置端口被占用时会自动顺延）。 */
    port: number;
    approvalGrants: typeof desktopApprovalGrants;
    /** 关闭 HTTP 监听并 flush 日志；5s 兜底超时，避免 SSE 长连接卡住退出。 */
    close: () => Promise<void>;
}

/** 端口被占用时向后顺延尝试的最大个数（含起始端口自身）。 */
const MAX_PORT_ATTEMPTS = 20;

/**
 * 探测某端口在指定 host 上是否空闲：临时 listen 一下，成功即判定空闲并立刻关闭。
 * 任何 error（EADDRINUSE / EACCES 等）都视作不可用。注意这是尽力而为的探测——探测后到真正
 * serve() 之间存在极小的 TOCTOU 窗口，但本服务只绑回环、端口又冷门，实际相撞概率可忽略；
 * 真正 serve() 仍保留 EADDRINUSE 兜底。
 */
function isPortFree(candidate: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => tester.close(() => resolve(true)));
        tester.listen(candidate, host);
    });
}

/** 从 start 起向后顺延查找一个空闲端口，最多尝试 MAX_PORT_ATTEMPTS 个。全部被占用才抛错。 */
async function findAvailablePort(start: number, host: string): Promise<number> {
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
        const candidate = start + i;
        if (candidate > 65535) break;
        if (await isPortFree(candidate, host)) return candidate;
    }
    throw new Error(
        `从端口 ${start} 起连续 ${MAX_PORT_ATTEMPTS} 个端口均被占用，无法启动。` +
            `查看占用者：lsof -nP -iTCP:${start} -sTCP:LISTEN，清理后重试。`
    );
}

/**
 * 启动后端 HTTP 服务（进程内）。使后端既能被 Electron 主进程直接 import 调用（无子进程），
 * 也能被 standalone 入口(index.ts/tsx)驱动。
 *
 * 语义：
 * - initializeServices 失败**不抛**，仍监听端口让 /health 暴 503（桌面端拿到明确错误而非连不上）。
 * - 配置端口被占用时**自动顺延**到下一个空闲端口，实际端口写回 process.env.PORT 并随
 *   RunningBackend.port 返回，调用方（Electron 主进程）据此告知前端真实地址。
 * - 连续多个端口都被占用才**抛出**，由调用方决定如何提示；serve() 处保留 EADDRINUSE 兜底。
 */
export async function startServer(channelPlugins?: Readonly<Record<string, string>>): Promise<RunningBackend> {
    const instance = await claimBackendInstance();
    try {
        const backend = await startListening(channelPlugins);
        try {
            await instance.publish(backend.port, getContainer()?.runtime.instanceId);
        } catch (error) {
            await backend.close();
            throw error;
        }
        let closing: Promise<void> | undefined;
        return {
            port: backend.port,
            approvalGrants: backend.approvalGrants,
            close: () => (closing ??= backend.close().finally(() => instance.release()))
        };
    } catch (error) {
        await instance.release();
        throw error;
    }
}

async function startListening(channelPlugins?: Readonly<Record<string, string>>): Promise<RunningBackend> {
    // 先确定真正可用的端口：决定后写回 process.env.PORT，使 port() / oauthCallbackUrl() 等
    // 后续读取者（含 initializeServices 内的 MCP OAuth 回调注册）都反映真实端口。
    const basePort = port();
    const PORT = await findAvailablePort(basePort, HOST);
    if (PORT !== basePort) {
        log.warn(`端口 ${basePort} 被占用，已自动切换到空闲端口 ${PORT}`);
    }
    process.env.PORT = String(PORT);

    try {
        await initializeServices(channelPlugins);
        log.info('Services initialized');
    } catch (error) {
        // 不抛：仍监听端口，让 /health 返回 503 暴露故障。
        log.error('服务初始化失败，将以不可用状态启动（/health 返回 503）', { err: error });
    }

    // 清理上次运行遗留的可恢复流文件（过期孤儿）。非阻塞、失败只告警。
    void cleanupStaleStreamFiles().catch((err) => log.warn('清理残留流文件失败', { err }));

    const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        let started = false;
        const instance = serve(
            {
                fetch: app.fetch,
                port: PORT,
                // 仅监听回环地址：后端暴露读密钥 / 起子进程等高危能力，绝不能对局域网可达。
                hostname: HOST
            },
            (info) => {
                started = true;
                log.info('追寻 Backend 已启动', {
                    address: `${info.address}:${info.port}`,
                    health: `http://localhost:${info.port}/health`,
                    skills: `http://localhost:${info.port}/api/skills`
                });
                resolve(instance);
            }
        );

        // 端口被占用时 @hono/node-server 只发 'error' 事件、不会自行退出。
        instance.on('error', (error: Error) => {
            if (!started) {
                if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
                    reject(
                        new Error(
                            `端口 ${PORT} 已被占用，可能有残留进程。查看占用者：lsof -nP -iTCP:${PORT} -sTCP:LISTEN，清理后重试。`
                        )
                    );
                } else {
                    reject(error);
                }
                return;
            }
            log.error('HTTP 服务运行期错误', { err: error });
        });
    });

    const close = (): Promise<void> =>
        new Promise<void>((resolve) => {
            desktopApprovalGrants.clear();
            // 先优雅停机：断开 MCP（含终止 stdio 子进程，防止残留 追寻.exe 致 Windows
            // 安装器误判应用在运行）+ 停渠道，再关 HTTP 监听。shutdownServices 永不抛错。
            void shutdownServices()
                .finally(() => {
                    server.close(() => {
                        void flushLogs().finally(resolve);
                    });
                })
                .catch(() => resolve());
            // 兜底：MCP 断连 / SSE 长连接未断开时不要卡住退出流程（SDK stdio close 最坏要
            // stdin 关闭→SIGTERM→SIGKILL）。5s 仍超时则强制让宿主继续退出。
            setTimeout(resolve, 5000).unref();
        });

    return { port: PORT, close, approvalGrants: desktopApprovalGrants };
}
