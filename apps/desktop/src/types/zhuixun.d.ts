/**
 * window.zhuixun 的 ambient 类型（preload 经 contextBridge 暴露）。
 * dev:web（纯浏览器）无 preload，故整体可选，渲染侧须做存在性守卫。
 */

/** 更新事件载荷（与 electron/updater.ts、electron/preload.ts 对齐）。 */
export type UpdaterEventPayload =
    | { type: 'checking' }
    | { type: 'available'; version: string; releaseNotes?: string; releaseUrl: string; canAutoInstall: boolean }
    | { type: 'not-available'; note?: string }
    | { type: 'progress'; percent: number; transferred: number; total: number }
    | { type: 'downloaded'; version: string }
    | { type: 'error'; message: string };

export interface UpdaterCheckResult {
    status: string;
    note?: string;
}

/** 更新渠道脱敏视图（与 electron/update-channels.ts 对齐；仅 id + 显示名，不含地址）。 */
export interface UpdateChannelView {
    id: string;
    displayName: string;
}

export interface ZhuixunBridge {
    platform: string;
    /** 后端实际监听端口（主进程注入；端口占用自动顺延后反映真实值）。 */
    backendPort?: number;
    approval?: {
        grant: (id: string) => Promise<string | null>;
        revoke: (id: string) => Promise<void>;
    };
    getAppVersion: () => Promise<string>;
    /** 后台任务运行期间阻止系统休眠。 */
    setKeepAwake: (active: boolean) => Promise<boolean>;
    /** 系统级桌面通知；平台不支持时返回 false。 */
    showNotification: (payload: { title: string; body?: string }) => Promise<boolean>;
    updater: {
        check: () => Promise<UpdaterCheckResult>;
        download: () => Promise<void>;
        quitAndInstall: () => Promise<void>;
        openReleasePage: (url?: string) => Promise<void>;
        listChannels: () => Promise<UpdateChannelView[]>;
        getChannel: () => Promise<string>;
        setChannel: (id: string) => Promise<{ id: string }>;
        onEvent: (cb: (payload: UpdaterEventPayload) => void) => () => void;
    };
}

declare global {
    interface Window {
        zhuixun?: ZhuixunBridge;
    }
}
