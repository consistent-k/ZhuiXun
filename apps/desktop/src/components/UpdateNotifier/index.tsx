import { App, Button } from 'antd';
import { useEffect } from 'react';

import {
    downloadUpdate,
    getAppVersion,
    isUpdaterSupported,
    openReleasePage,
    quitAndInstall,
    subscribeUpdaterEvents
} from '@/services/updater';
import { useUpdaterStore } from '@/stores';

/**
 * 全局更新提示：挂在 <App/> 上下文内，订阅主进程推送的更新事件，写入 store 并弹可操作通知。
 * - win：新版可用 → 提示下载 → 下载完成 → 提示重启安装。
 * - mac：新版可用 → 提示前往 release 页手动下载（无签名不能应用内安装）。
 * - error：仅写 store（启动自动检查失败不打扰用户），由设置页呈现。渲染 null。
 */
export function UpdateNotifier() {
    const { notification } = App.useApp();
    const applyEvent = useUpdaterStore((s) => s.applyEvent);
    const setCurrentVersion = useUpdaterStore((s) => s.setCurrentVersion);

    useEffect(() => {
        if (!isUpdaterSupported()) return;
        void getAppVersion().then((v) => {
            if (v) setCurrentVersion(v);
        });

        return subscribeUpdaterEvents((payload) => {
            applyEvent(payload);

            if (payload.type === 'available') {
                const key = `update-available-${payload.version}`;
                notification.open({
                    key,
                    title: `发现新版本 v${payload.version}`,
                    description: payload.canAutoInstall
                        ? '新版本已就绪，可直接下载更新。'
                        : 'macOS 需前往下载页手动安装新版本。',
                    duration: 0,
                    actions: (
                        <Button
                            type="primary"
                            size="small"
                            onClick={() => {
                                notification.destroy(key);
                                if (payload.canAutoInstall) void downloadUpdate();
                                else void openReleasePage(payload.releaseUrl);
                            }}
                        >
                            {payload.canAutoInstall ? '下载更新' : '前往下载'}
                        </Button>
                    )
                });
            }

            if (payload.type === 'downloaded') {
                const key = `update-downloaded-${payload.version}`;
                notification.success({
                    key,
                    title: `v${payload.version} 已下载完成`,
                    description: '重启应用以完成安装。',
                    duration: 0,
                    actions: (
                        <Button
                            type="primary"
                            size="small"
                            onClick={() => {
                                notification.destroy(key);
                                void quitAndInstall();
                            }}
                        >
                            重启并安装
                        </Button>
                    )
                });
            }
        });
    }, [applyEvent, setCurrentVersion, notification]);

    return null;
}

export default UpdateNotifier;
