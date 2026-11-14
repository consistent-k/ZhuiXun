import type { UpdateChannelView, UpdaterCheckResult, UpdaterEventPayload } from '@/types/zhuixun';

/**
 * 应用更新的渲染侧客户端。
 *
 * 注意：这是 Electron **IPC** 封装（经 preload 的 window.zhuixun），**不是 HTTP service**，
 * 不走 @/utils/request、不打 127.0.0.1:3001。dev:web（纯浏览器）无 preload，一律做存在性守卫。
 */

function bridge() {
    return typeof window !== 'undefined' ? window.zhuixun : undefined;
}

/** 当前环境是否支持应用更新（仅 Electron 壳内有 preload）。 */
export function isUpdaterSupported(): boolean {
    return !!bridge()?.updater;
}

export async function getAppVersion(): Promise<string> {
    return (await bridge()?.getAppVersion()) ?? '';
}

export async function checkForUpdate(): Promise<UpdaterCheckResult> {
    return (await bridge()?.updater.check()) ?? { status: 'not-available', note: '当前环境不支持应用更新' };
}

export async function downloadUpdate(): Promise<void> {
    await bridge()?.updater.download();
}

export async function quitAndInstall(): Promise<void> {
    await bridge()?.updater.quitAndInstall();
}

export async function openReleasePage(url?: string): Promise<void> {
    await bridge()?.updater.openReleasePage(url);
}

/** 列出内置更新渠道（仅 id + 显示名，不含地址）。不支持环境返回空数组。 */
export async function listUpdateChannels(): Promise<UpdateChannelView[]> {
    return (await bridge()?.updater.listChannels()) ?? [];
}

/** 取当前所选更新渠道 id。不支持环境返回空串。 */
export async function getUpdateChannel(): Promise<string> {
    return (await bridge()?.updater.getChannel()) ?? '';
}

/** 切换更新渠道（主进程白名单校验 + 持久化，打包态下按新渠道即时检查）。 */
export async function setUpdateChannel(id: string): Promise<{ id: string }> {
    return (await bridge()?.updater.setChannel(id)) ?? { id };
}

/** 订阅主进程推送的更新事件；返回取消订阅函数（不支持时返回 noop）。 */
export function subscribeUpdaterEvents(cb: (payload: UpdaterEventPayload) => void): () => void {
    const b = bridge();
    if (!b?.updater) return () => {};
    return b.updater.onEvent(cb);
}
