import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * 最小 preload（sandbox + contextIsolation 下运行）。
 *
 * 渲染进程与后端全部走 HTTP(127.0.0.1:3001)，不需要 Node 能力下放。这里只经 contextBridge
 * 暴露极少量只读信息 + 应用更新的 IPC 封装（不暴露 ipcRenderer 原始对象，只给固定通道名方法）。
 */

/** 更新渠道脱敏视图（与主进程 update-channels.ts 对齐；仅 id + 显示名，不含地址）。 */
type UpdateChannelView = { id: string; displayName: string };

/** 更新事件载荷（与主进程 electron/updater.ts 的 UpdaterEvent 对齐）。 */
type UpdaterEventPayload =
    | { type: 'checking' }
    | { type: 'available'; version: string; releaseNotes?: string; releaseUrl: string; canAutoInstall: boolean }
    | { type: 'not-available'; note?: string }
    | { type: 'progress'; percent: number; transferred: number; total: number }
    | { type: 'downloaded'; version: string }
    | { type: 'error'; message: string };

/**
 * 从主进程注入的渲染进程启动参数中解析后端真实端口。
 * 主进程在 createWindow 的 webPreferences.additionalArguments 里以
 * `--zhuixun-backend-port=<port>` 传入（后端端口被占用会自动顺延，故不能写死）。
 * sandbox preload 可读 process.argv（与已用的 process.platform 同源）。
 */
function readBackendPort(): number | undefined {
    const prefix = '--zhuixun-backend-port=';
    const arg = process.argv.find((a) => a.startsWith(prefix));
    const parsed = arg ? Number(arg.slice(prefix.length)) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

contextBridge.exposeInMainWorld('zhuixun', {
    /** 平台标识，便于前端做极少量差异化（如 win/mac 更新文案）。 */
    platform: process.platform,
    /** 后端实际监听端口（主进程注入）。前端据此拼接 API 基地址，兼容端口占用自动顺延。 */
    backendPort: readBackendPort(),
    approval: {
        grant: (id: string): Promise<string | null> => ipcRenderer.invoke('approval:grant', id),
        revoke: (id: string): Promise<void> => ipcRenderer.invoke('approval:revoke', id)
    },
    /** 取应用版本（主进程经 app.getVersion 返回）。 */
    getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
    /** 后台任务运行期间阻止系统休眠；返回主进程侧 blocker 是否生效。 */
    setKeepAwake: (active: boolean): Promise<boolean> => ipcRenderer.invoke('power:set-keep-awake', active),
    /** 系统级桌面通知（窗口不在前台时用于任务完成提醒）；平台不支持时返回 false。 */
    showNotification: (payload: { title: string; body?: string }): Promise<boolean> =>
        ipcRenderer.invoke('notify:show', payload),
    /** 应用更新 IPC 封装。 */
    updater: {
        check: (): Promise<{ status: string; note?: string }> => ipcRenderer.invoke('updater:check'),
        download: (): Promise<void> => ipcRenderer.invoke('updater:download'),
        quitAndInstall: (): Promise<void> => ipcRenderer.invoke('updater:quitAndInstall'),
        openReleasePage: (url?: string): Promise<void> => ipcRenderer.invoke('updater:openReleasePage', url),
        /** 内置更新渠道清单（仅 id + 显示名，不含地址）。 */
        listChannels: (): Promise<UpdateChannelView[]> => ipcRenderer.invoke('updater:listChannels'),
        /** 当前所选渠道 id。 */
        getChannel: (): Promise<string> => ipcRenderer.invoke('updater:getChannel'),
        /** 切换渠道（主进程白名单校验 + 持久化，打包态下按新渠道即时检查）。 */
        setChannel: (id: string): Promise<{ id: string }> => ipcRenderer.invoke('updater:setChannel', id),
        /** 订阅主进程推送的更新事件，返回取消订阅函数。 */
        onEvent: (cb: (payload: UpdaterEventPayload) => void): (() => void) => {
            const listener = (_e: IpcRendererEvent, payload: UpdaterEventPayload): void => cb(payload);
            ipcRenderer.on('updater:event', listener);
            return () => ipcRenderer.removeListener('updater:event', listener);
        }
    }
});
