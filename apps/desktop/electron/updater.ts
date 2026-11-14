import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater';

import {
    currentChannel,
    downloadPageFor,
    getSelectedChannelId,
    listChannelViews,
    setSelectedChannelId,
    type UpdateChannelView
} from './update-channels.ts';

// electron-updater 是 CJS，ESM 主进程下用默认导入再解构（固定写法）。
const { autoUpdater } = electronUpdater;

/**
 * 应用更新内核（主进程）。
 *
 * - 全局 autoDownload=false：命中新版本后由渲染侧用户确认再下载/跳转，UX 可控。
 * - 多渠道：feed 不写死，由内置渠道注册表（update-channels.ts）按用户所选 id 提供；每次检查前
 *   setFeedURL 切到当前渠道。渠道地址全部内置、不经 settings.json、不下发渲染进程。
 * - 平台分叉（两端均无代码签名）：
 *     - Windows：应用内下载 + quitAndInstall 全自动。
 *     - macOS：Squirrel.Mac 强校验签名，无签名无法安装 → 只做"检测"，命中后跳转下载页手动安装。
 * - dev（!app.isPackaged）：不检查更新，但仍注册全部 IPC（含渠道列表/切换），渲染侧 invoke 不报错。
 */

const isMac = process.platform === 'darwin';

type UpdaterEvent =
    | { type: 'checking' }
    | { type: 'available'; version: string; releaseNotes?: string; releaseUrl: string; canAutoInstall: boolean }
    | { type: 'not-available'; note?: string }
    | { type: 'progress'; percent: number; transferred: number; total: number }
    | { type: 'downloaded'; version: string }
    | { type: 'error'; message: string };

type CheckResult = { status: 'checking' | 'not-available' | 'error'; note?: string };

let getWindow: (() => BrowserWindow | undefined) | undefined;
let wired = false;

function send(event: UpdaterEvent): void {
    const win = getWindow?.();
    if (win && !win.isDestroyed()) win.webContents.send('updater:event', event);
}

function notesToString(notes: UpdateInfo['releaseNotes']): string | undefined {
    if (!notes) return undefined;
    if (typeof notes === 'string') return notes;
    return notes.map((n) => (typeof n === 'string' ? n : (n.note ?? ''))).join('\n');
}

/** 把 feed 切到当前所选渠道（每次检查前调用，使切换渠道即时生效）。 */
function applyCurrentFeed(): void {
    autoUpdater.setFeedURL(currentChannel().feed);
}

function wireAutoUpdaterEvents(): void {
    if (wired) return;
    wired = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => send({ type: 'checking' }));
    autoUpdater.on('update-available', (info: UpdateInfo) =>
        send({
            type: 'available',
            version: info.version,
            releaseNotes: notesToString(info.releaseNotes),
            // 下载页按当前渠道取（github→tag 页；generic/obs→渠道下载页）
            releaseUrl: downloadPageFor(currentChannel(), info.version),
            // mac 无签名不能应用内安装 → 渲染侧据此降级为"前往下载"
            canAutoInstall: !isMac
        })
    );
    autoUpdater.on('update-not-available', () => send({ type: 'not-available' }));
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
        send({ type: 'progress', percent: Math.round(p.percent), transferred: p.transferred, total: p.total })
    );
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => send({ type: 'downloaded', version: info.version }));
    autoUpdater.on('error', (err: Error) => send({ type: 'error', message: err.message }));
}

function registerIpcHandlers(): void {
    // 渠道清单（脱敏，仅 id + 显示名，不含地址）；dev 也可用，供设置页渲染单选。
    ipcMain.handle('updater:listChannels', (): UpdateChannelView[] => listChannelViews());

    // 当前所选渠道 id。
    ipcMain.handle('updater:getChannel', (): string => getSelectedChannelId());

    // 切换渠道：白名单校验 + 持久化，成功后按新渠道立即检查一次（打包态）。
    ipcMain.handle('updater:setChannel', async (_e: IpcMainInvokeEvent, id: string): Promise<{ id: string }> => {
        try {
            setSelectedChannelId(id);
        } catch (error) {
            send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            return { id: getSelectedChannelId() };
        }
        if (app.isPackaged) {
            try {
                applyCurrentFeed();
                send({ type: 'checking' });
                await autoUpdater.checkForUpdates();
            } catch (error) {
                send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            }
        }
        return { id: getSelectedChannelId() };
    });

    ipcMain.handle('updater:check', async (): Promise<CheckResult> => {
        if (!app.isPackaged) return { status: 'not-available', note: 'dev 环境不检查更新' };
        try {
            applyCurrentFeed();
            send({ type: 'checking' });
            await autoUpdater.checkForUpdates();
            return { status: 'checking' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send({ type: 'error', message });
            return { status: 'error', note: message };
        }
    });

    // 仅 Windows：mac 无签名下不能应用内安装，渲染侧不会触发此通道（双保险这里也拦）。
    ipcMain.handle('updater:download', async (): Promise<void> => {
        if (!app.isPackaged || isMac) return;
        try {
            await autoUpdater.downloadUpdate();
        } catch (error) {
            send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
    });

    ipcMain.handle('updater:quitAndInstall', (): void => {
        if (!app.isPackaged || isMac) return;
        // isSilent=false（显示安装器）, isForceRunAfter=true（装完自动重开）
        autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.handle('updater:openReleasePage', async (_e: IpcMainInvokeEvent, url?: string): Promise<void> => {
        await shell.openExternal(url ?? downloadPageFor(currentChannel()));
    });
}

/** 主进程启动时调用：注册 IPC、绑定事件、打包态下按当前渠道启动自动检查一次。 */
export function initUpdater(windowGetter: () => BrowserWindow | undefined): void {
    getWindow = windowGetter;
    registerIpcHandlers();

    if (!app.isPackaged) return; // dev：不检查更新（IPC 已注册，渲染侧 invoke 正常返回）

    wireAutoUpdaterEvents();
    applyCurrentFeed();
    // 启动自动检查一次（autoDownload=false，命中后由渲染侧确认再下载/跳转）
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    });
}
