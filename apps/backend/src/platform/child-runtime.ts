import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
export function resolveStdioLaunch(command: string, args?: string[]): StdioLaunch {
    if (command === 'node' || command === 'node.exe') {
        return { command: process.execPath, args, usesInternalNode: true };
    }
    if (command === 'npx' || command === 'npx.cmd') {
        const cli = bundledNpxCli();
        if (cli) return { command: process.execPath, args: [cli, ...(args ?? [])], usesInternalNode: true };
    }
    if (command === 'npm' || command === 'npm.cmd') {
        const npx = bundledNpxCli();
        const candidates = [
            ...(npx ? [path.join(path.dirname(npx), 'npm-cli.js')] : []),
            path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
            path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
        ];
        const cli = candidates.find((file) => fs.existsSync(file));
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

export function buildStdioEnv(configEnv?: Record<string, string>): Record<string, string> {
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
