import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    net,
    Notification,
    powerSaveBlocker,
    protocol,
    shell,
    Tray,
    type IpcMainInvokeEvent,
    type MenuItemConstructorOptions
} from 'electron';

import { initUpdater } from './updater.ts';

/**
 * 追寻 Electron 主进程入口。
 *
 * 架构：后端(Hono)不作为子进程被 spawn，而是由主进程直接 import 其编译产物(dist/server.js)
 * 在**进程内**起 HTTP 服务；前后端仍走 127.0.0.1:3001 的 HTTP 边界，渲染进程(React SPA)零改动。
 *
 * 生命周期：
 * - app.whenReady → startServer() 进程内起后端，再建窗
 * - macOS 关窗隐藏到 Dock，Windows 关窗隐藏到托盘，Dock / 托盘 / 再次启动可恢复同一窗口
 * - before-quit → backend.close()（无子进程，优雅关 HTTP 即可）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// 渲染进程来源：dev 指向 vite dev server(vite-plugin-electron 注入 VITE_DEV_SERVER_URL)，
// prod 走自定义 app:// 协议加载打包后的 SPA。
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:8080';
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://local`;

/** 后端默认端口兜底，与后端 config/server.ts 的 port() 默认值一致；实际以启动后 backend.port 为准。 */
const DEFAULT_BACKEND_PORT = 31001;

/** 后端编译产物(dist/server.js，导出 startServer)的绝对路径。 */
function resolveBackendEntry(): string {
    if (isDev) {
        // dist-electron/main.mjs → ../../backend/dist/server.js（apps/ 下 frontend 与 backend 平级）
        return path.resolve(__dirname, '../../backend/dist/server.js');
    }
    // 打包形态：electron-builder 的 extraResources 把 apps/backend/dist 映射到 resources/backend
    return path.join(process.resourcesPath, 'backend', 'server.js');
}

/** 打包后 SPA(vite 产物)的根目录。dev 不用（走 vite dev server）。 */
function resolveRendererDist(): string {
    // app.getAppPath() 指向加载 main 的 package.json 所在目录（打包后即 app.asar 内 frontend 根）
    return path.join(app.getAppPath(), 'dist');
}

/** 开发态使用对应平台资源，打包态 Windows 另带一份 ICO 供系统托盘读取。 */
function windowsIconPath(): string {
    return isDev ? path.join(__dirname, '../build/icon.ico') : path.join(process.resourcesPath, 'icon.ico');
}

type RunningBackend = {
    port: number;
    close: () => Promise<void>;
    approvalGrants: { grant: (id: string) => string; revoke: (id: string) => void; clear: () => void };
};

let backend: RunningBackend | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let shuttingDown = false;

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('com.zhuixun.app');

function showMainWindow(): void {
    if (!backend || shuttingDown) return;
    if (!mainWindow) createWindow();
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
}

app.on('activate', showMainWindow);
app.on('second-instance', showMainWindow);

function configureDesktopMenu(): void {
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);
        return;
    }

    app.setAboutPanelOptions({ applicationName: '追寻', applicationVersion: app.getVersion() });
    const viewItems: MenuItemConstructorOptions[] = [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
    ];
    if (isDev)
        viewItems.push(
            { type: 'separator' },
            { role: 'reload', label: '刷新' },
            { role: 'toggleDevTools', label: '开发者工具' }
        );

    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            {
                label: '追寻',
                submenu: [
                    { role: 'about', label: '关于追寻' },
                    { type: 'separator' },
                    { role: 'hide', label: '隐藏追寻' },
                    { role: 'hideOthers', label: '隐藏其他应用' },
                    { role: 'unhide', label: '显示全部' },
                    { type: 'separator' },
                    { role: 'quit', label: '退出追寻' }
                ]
            },
            {
                label: '编辑',
                submenu: [
                    { role: 'undo', label: '撤销' },
                    { role: 'redo', label: '重做' },
                    { type: 'separator' },
                    { role: 'cut', label: '剪切' },
                    { role: 'copy', label: '复制' },
                    { role: 'paste', label: '粘贴' },
                    { role: 'selectAll', label: '全选' }
                ]
            },
            { label: '显示', submenu: viewItems },
            {
                role: 'windowMenu',
                label: '窗口',
                submenu: [
                    { role: 'minimize', label: '最小化' },
                    { role: 'close', label: '关闭窗口' },
                    { type: 'separator' },
                    { label: '显示主窗口', click: showMainWindow }
                ]
            }
        ])
    );
}

function setupWindowsTray(): void {
    const image = nativeImage.createFromPath(windowsIconPath());
    if (image.isEmpty()) {
        console.warn('[main] 无法读取托盘图标，关闭窗口时会退出');
        return;
    }
    const windowsTray = new Tray(image);
    windowsTray.setToolTip('追寻');
    windowsTray.setContextMenu(
        Menu.buildFromTemplate([
            { label: '打开追寻', click: showMainWindow },
            { type: 'separator' },
            { label: '退出追寻', click: () => app.quit() }
        ])
    );
    windowsTray.on('click', showMainWindow);
    tray = windowsTray;
}

/** 进程内启动后端。失败时弹原生 dialog 并退出（端口占用等不可恢复场景）。 */
async function startBackend(): Promise<void> {
    // 让后端走生产语义（落盘日志、onError 行为等）。从 Finder 拉起不会带 NODE_ENV。
    if (!isDev && !process.env.NODE_ENV) process.env.NODE_ENV = 'production';
    // 告知后端随包资源目录，用于定位随包分发的 npm/npx-cli.js（打包形态）。dev 不设，回落本机 npx。
    if (!isDev) process.env.ZHUIXUN_BACKEND_RESOURCES = path.join(process.resourcesPath, 'backend');
    // 指向随包的 ripgrep（afterPack 拷进 resources/rg/）：后端 bundle external 了 @vscode/ripgrep，
    // 打包形态无法从 node_modules 解析，须显式指定。dev 不设，后端自行经 node_modules 解析 rgPath。
    if (!isDev && !process.env.ZHUIXUN_RG_PATH) {
        const rgBin = process.platform === 'win32' ? 'rg.exe' : 'rg';
        process.env.ZHUIXUN_RG_PATH = path.join(process.resourcesPath, 'rg', rgBin);
    }

    const entry = resolveBackendEntry();
    try {
        // 动态 import 后端 ESM 产物（路径为运行时计算，esbuild 不会把它打进来，保持外部）。
        const mod: { startServer: () => Promise<RunningBackend> } = await import(pathToFileURL(entry).href);
        backend = await mod.startServer();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox('追寻 后端启动失败', `${message}\n\n后端入口：${entry}`);
        app.exit(1);
        throw error;
    }
}

/** 注册 app:// 协议：从打包的 SPA dist 目录按路径取文件，附加 CSP 头。 */
function registerAppProtocol(): void {
    const rendererDist = resolveRendererDist();
    // CSP 的 connect-src 需放行后端真实端口：端口被占用会自动顺延，故用启动后得到的实际端口而非写死。
    const csp = buildCsp(backend?.port);
    protocol.handle(APP_SCHEME, async (request) => {
        const { pathname } = new URL(request.url);
        // hash 路由下任何非资源路径都回退到 index.html（冷启动直达深链）。
        const rel = pathname === '/' || pathname === '' ? 'index.html' : decodeURIComponent(pathname.slice(1));
        let filePath = path.join(rendererDist, rel);
        // 防目录穿越：解析后必须仍在 dist 内。
        if (!filePath.startsWith(rendererDist)) filePath = path.join(rendererDist, 'index.html');
        const response = await net.fetch(pathToFileURL(filePath).href);
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', csp);
        return new Response(response.body, { status: response.status, headers });
    });
}

/** 生产环境 CSP：self + app://local，connect-src 放行后端 127.0.0.1:<实际端口>。 */
function buildCsp(backendPort = DEFAULT_BACKEND_PORT): string {
    return [
        "default-src 'self' app://local",
        "script-src 'self' 'unsafe-inline' app://local",
        "style-src 'self' 'unsafe-inline' app://local",
        "img-src 'self' data: blob: https: app://local",
        "font-src 'self' data: app://local",
        `connect-src 'self' app://local http://localhost:${backendPort} http://127.0.0.1:${backendPort} https: ws: wss:`
    ].join('; ');
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        title: '追寻 · 个人 AI 助理',
        width: 1165,
        height: 765,
        minWidth: 960,
        minHeight: 640,
        resizable: true,
        ...(process.platform === 'win32' ? { icon: windowsIconPath() } : {}),
        // 自定义顶栏：隐藏原生标题栏，窗口控制键仍由 OS 绘制——
        // mac 保留红绿灯(trafficLightPosition 垂直居中到侧栏品牌区)，
        // win/linux 用 titleBarOverlay 在右上角叠加系统三键(本期固定浅色，symbolColor=colors.muted)。
        // 渲染侧只负责声明拖拽区(-webkit-app-region)与让位，无需自实现 min/max/close 的 IPC。
        titleBarStyle: 'hidden',
        ...(process.platform === 'darwin'
            ? { trafficLightPosition: { x: 16, y: 12 } }
            : { titleBarOverlay: { color: '#00000000', symbolColor: '#6c6a64', height: 40 } }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            // 把后端实际端口透传给 preload（端口占用会自动顺延，故用运行时值而非写死）；
            // preload 读 process.argv 解析后经 contextBridge 暴露为 window.zhuixun.backendPort。
            additionalArguments: [`--zhuixun-backend-port=${backend?.port ?? DEFAULT_BACKEND_PORT}`],
            // 安全基线：渲染进程只经 HTTP 与后端通信，不需要 Node 能力下放。
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    // 外链不在应用内打开，交给系统浏览器。
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });

    // 兜底：任何试图把当前窗口导航到应用自身来源之外的行为（如正文里漏了 target 的裸链、
    // 第三方脚本改 location）一律拦下并交系统默认浏览器，防止应用壳被外链替换。
    // 应用自身来源：dev 的 vite server 与 prod 的 app://local，放行其内部（含 hash 路由）跳转。
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith(APP_ORIGIN) || url.startsWith(DEV_SERVER_URL)) return;
        event.preventDefault();
        void shell.openExternal(url);
    });

    if (isDev) {
        void mainWindow.loadURL(DEV_SERVER_URL);
        // dev 下右键菜单：检查元素 / 开关控制台，方便从任意位置唤起 DevTools。
        mainWindow.webContents.on('context-menu', (_event, params) => {
            const wc = mainWindow?.webContents;
            if (!wc) return;
            Menu.buildFromTemplate([
                {
                    label: '检查元素',
                    click: () => wc.inspectElement(params.x, params.y)
                },
                {
                    label: wc.isDevToolsOpened() ? '关闭控制台' : '打开控制台',
                    click: () => (wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools())
                },
                { type: 'separator' },
                { label: '刷新', click: () => wc.reload() }
            ]).popup({ window: mainWindow });
        });
    } else {
        void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
    }

    mainWindow.webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) backend?.approvalGrants.clear();
    });
    mainWindow.on('close', (event) => {
        if (shuttingDown || (process.platform !== 'darwin' && !tray)) return;
        event.preventDefault();
        // 隐藏而非销毁渲染进程，避免中断活跃会话或丢失输入框草稿。
        mainWindow?.hide();
    });
    mainWindow.on('closed', () => {
        backend?.approvalGrants.clear();
        mainWindow = undefined;
    });
}

// app:// 必须在 app ready 前声明为「标准 + 安全」协议，fetch/CSP 才按预期工作。
protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

app.whenReady()
    .then(async () => {
        if (!primaryInstance) return;
        configureDesktopMenu();
        // dev 下 mac 没有 .app 包，手动设 Dock 图标，否则显示默认 Electron 图标。
        if (isDev && process.platform === 'darwin') {
            const icon = nativeImage.createFromPath(path.join(__dirname, '../build/icon.png'));
            if (!icon.isEmpty()) app.dock?.setIcon(icon);
        }
        ipcMain.handle('app:getVersion', () => app.getVersion());
        await startBackend();
        if (!isDev) registerAppProtocol();
        showMainWindow();
        if (process.platform === 'win32') setupWindowsTray();
        // 应用更新：注册 IPC + 绑定事件；打包态下启动自动检查一次（dev 为 no-op）。
        initUpdater(() => mainWindow);
    })
    .catch((error) => {
        // startBackend 已自行弹窗并 exit；这里兜底记录。
        console.error('[main] 启动失败', error);
    });

function approvalWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
    const window = mainWindow;
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    const url = new URL(event.senderFrame.url);
    if (isDev ? url.origin === new URL(DEV_SERVER_URL).origin : url.protocol === 'app:' && url.host === 'local') {
        return window;
    }
}

ipcMain.handle('approval:grant', async (event, sessionId: string): Promise<string | null> => {
    const window = approvalWindow(event);
    if (!window || !backend || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
    const conversationHash = `#/chat/${sessionId}`;
    if (new URL(event.sender.getURL()).hash !== conversationHash) return null;
    const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '启用完全访问权限',
        message: '允许本会话跳过普通工具审批？',
        detail: '追寻可直接执行命令和修改当前进程有权访问的文件。切换审批模式或退出应用会撤销授权。',
        buttons: ['取消', '启用完全访问权限'],
        defaultId: 0,
        cancelId: 0
    });
    // 原生弹窗关闭前 renderer 可能已经导航或退出，因此确认后再次校验来源。
    return response === 1 &&
        approvalWindow(event) === window &&
        new URL(event.sender.getURL()).hash === conversationHash
        ? (backend?.approvalGrants.grant(sessionId) ?? null)
        : null;
});

ipcMain.handle('approval:revoke', (event, sessionId: string): void => {
    if (approvalWindow(event) && typeof sessionId === 'string') backend?.approvalGrants.revoke(sessionId);
});

// 后台任务运行期间阻止系统休眠（对齐 ZCode 的 offpeak-active-count → powerSaveBlocker）：
// 由渲染层按 running 计数经 IPC 切换；id 保存在主进程，避免重复 start 泄漏 blocker。
let keepAwakeId: number | null = null;
ipcMain.handle('power:set-keep-awake', (_event, active: boolean) => {
    if (active && keepAwakeId === null) {
        keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!active && keepAwakeId !== null) {
        powerSaveBlocker.stop(keepAwakeId);
        keepAwakeId = null;
    }
    return powerSaveBlocker.isStarted(keepAwakeId ?? -1);
});

/**
 * 系统级桌面通知：窗口不在前台时由渲染层调用（定时任务/后台任务完成）。
 * 点击通知回到应用；返回是否真的显示成功，调用方据此回退到应用内通知。
 *
 * 注意：macOS 下未签名/未注册通知中心的 Electron（开发态）会静默失败——`isSupported()` 仍为
 * true，`show()` 不抛错，只在 `failed` 事件里给出 UNErrorDomain 1（应用无通知授权）。
 * 因此必须等 `show`/`failed` 之一再返回，不能调用完 `show()` 就假定成功。
 */
ipcMain.handle('notify:show', (_event, payload: { title: string; body?: string }) => {
    if (!Notification.isSupported()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };

        const notification = new Notification({
            title: payload.title,
            body: payload.body ?? ''
        });
        notification.on('show', () => finish(true));
        notification.on('failed', (_e, error) => {
            console.warn('[main] 系统通知发送失败，回退应用内通知', error);
            finish(false);
        });
        notification.on('click', showMainWindow);
        notification.show();
        // 兜底：个别平台/系统版本既不触发 show 也不触发 failed，避免渲染层一直悬着。
        setTimeout(() => finish(false), 3000);
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit();
});

// 退出前优雅关闭进程内后端（无子进程可 kill）。
app.on('before-quit', (event) => {
    // 退出前释放 keep-awake，避免 blocker 残留在系统电源状态里。
    if (keepAwakeId !== null) {
        powerSaveBlocker.stop(keepAwakeId);
        keepAwakeId = null;
    }
    if (!backend) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    tray?.destroy();
    tray = undefined;
    void backend
        .close()
        .catch((error: unknown) => console.error('[main] 关闭后端失败', error))
        .finally(() => {
            backend = undefined;
            // 走 Electron 的正常退出事件，Windows 的更新器依赖 quit 触发安装。
            app.quit();
        });
});
