// Standalone 入口：供 `pnpm dev:backend`(tsx --watch) / `pnpm start` 的后端单跑场景使用。
// 真正的启动逻辑在 ./server 的 startServer()——Electron 主进程直接 import 它在进程内起后端，
// 不再经由本文件 spawn 子进程。本文件只负责「作为独立进程跑」时的信号处理与退出码。
//
// 注意：server.ts 的第一行副作用导入了 bootstrap-settings，import 它即保证引导先于任何 config 读取。
import { createLogger, flushLogs } from './platform/logging/index';
import { startServer } from './server';

const log = createLogger('Boot');

async function main() {
    let backend;
    try {
        backend = await startServer();
    } catch (error) {
        // 端口被占等启动失败：standalone 场景直接报错退出，让 dev 脚本/终端立刻看到原因。
        log.error('后端启动失败', { err: error });
        void flushLogs().finally(() => process.exit(1));
        return;
    }

    // 收到 TERM/INT 时先关闭监听端口再退出。
    // --watch 重启、concurrently -k 收尾都依赖这一步，否则旧进程会一直占用端口不释放。
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`收到 ${signal}，正在关闭服务...`);
        void backend.close().finally(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main();
