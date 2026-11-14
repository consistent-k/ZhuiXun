import { create } from 'zustand';

import type { UpdateChannelView, UpdaterEventPayload } from '@/types/zhuixun';

/**
 * 应用更新运行时状态 store（瞬态，不持久化）。
 * 事件真源在主进程（electron/updater.ts），经 UpdateNotifier 订阅后用 applyEvent 写入这里；
 * 设置页 AppUpdatePanel 读此 store 渲染状态/进度。
 */

export type UpdaterStatus =
    'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

interface UpdaterProgress {
    percent: number;
    transferred: number;
    total: number;
}

interface UpdaterState {
    status: UpdaterStatus;
    currentVersion: string;
    latestVersion?: string;
    releaseNotes?: string;
    releaseUrl?: string;
    canAutoInstall: boolean;
    progress?: UpdaterProgress;
    errorMessage?: string;
    /** 内置更新渠道清单（仅 id + 显示名）。 */
    channels: UpdateChannelView[];
    /** 当前所选渠道 id。 */
    channelId?: string;
}

interface UpdaterActions {
    setCurrentVersion: (v: string) => void;
    setChannels: (channels: UpdateChannelView[]) => void;
    setChannelId: (id: string) => void;
    applyEvent: (e: UpdaterEventPayload) => void;
    reset: () => void;
}

const initialState: UpdaterState = {
    status: 'idle',
    currentVersion: '',
    canAutoInstall: false,
    channels: []
};

export const useUpdaterStore = create<UpdaterState & UpdaterActions>((set) => ({
    ...initialState,
    setCurrentVersion: (v) => set({ currentVersion: v }),
    setChannels: (channels) => set({ channels }),
    setChannelId: (channelId) => set({ channelId }),
    applyEvent: (e) =>
        set((state) => {
            switch (e.type) {
                case 'checking':
                    return { status: 'checking', errorMessage: undefined };
                case 'available':
                    return {
                        status: 'available',
                        latestVersion: e.version,
                        releaseNotes: e.releaseNotes,
                        releaseUrl: e.releaseUrl,
                        canAutoInstall: e.canAutoInstall
                    };
                case 'not-available':
                    return { status: 'not-available' };
                case 'progress':
                    return {
                        status: 'downloading',
                        progress: { percent: e.percent, transferred: e.transferred, total: e.total }
                    };
                case 'downloaded':
                    return { status: 'downloaded', latestVersion: e.version };
                case 'error':
                    return { status: 'error', errorMessage: e.message };
                default:
                    return state;
            }
        }),
    reset: () => set(initialState)
}));
