import type { HooksView } from '@zhuixun/shared';

import { updateHooksSettings } from '@/config/settings-store';

import { hooksView, loadHooksFile } from './config';

/**
 * hooks 模块公开契约：hooks.json（仅手工编辑）的只读视图、hash 信任闸口与执行器。
 *
 * 信任闸口：只有总开关开启且当前文件 sha256 等于用户确认过的 hash 才执行；
 * 文件被改动即回到「待信任」。`settings.hooks` 不参与设置导入导出。
 */
export type { HookAuditEntry, HooksView } from '@zhuixun/shared';
export { hooksView, resetHooksCache } from './config';
export { createHookRunner, readHookAudit, type HookRunContext, type HookRunner } from './runner';

export class HooksTrustError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HooksTrustError';
    }
}

/**
 * 信任当前配置 / 切换总开关。
 * 传入的 hash 必须等于此刻文件的 hash（防用户审阅后文件被替换的 TOCTOU），否则抛 HooksTrustError。
 */
export function updateHooksTrust(patch: { hash?: string; enabled?: boolean }): HooksView {
    if (patch.hash !== undefined) {
        const loaded = loadHooksFile();
        if (loaded.status !== 'ready' || loaded.hash !== patch.hash) {
            throw new HooksTrustError('配置已变化，请刷新后重新确认');
        }
    }
    updateHooksSettings({
        ...(patch.hash !== undefined ? { trustedHash: patch.hash } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {})
    });
    return hooksView();
}
