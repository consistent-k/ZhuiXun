import { useRequest } from 'ahooks';
import { App, Button, Progress, Radio, Tag } from 'antd';
import { useEffect } from 'react';

import {
    checkForUpdate,
    downloadUpdate,
    getUpdateChannel,
    isUpdaterSupported,
    listUpdateChannels,
    openReleasePage,
    quitAndInstall,
    setUpdateChannel
} from '@/services/updater';
import { useUpdaterStore } from '@/stores';

import useStyles from './styles';

/** 设置「应用设置」页的「关于与更新」区块：当前版本 + 更新渠道 + 手动检查 + 状态/进度/平台差异。 */
export function AppUpdatePanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const supported = isUpdaterSupported();

    const status = useUpdaterStore((s) => s.status);
    const currentVersion = useUpdaterStore((s) => s.currentVersion);
    const latestVersion = useUpdaterStore((s) => s.latestVersion);
    const canAutoInstall = useUpdaterStore((s) => s.canAutoInstall);
    const progress = useUpdaterStore((s) => s.progress);
    const releaseUrl = useUpdaterStore((s) => s.releaseUrl);
    const errorMessage = useUpdaterStore((s) => s.errorMessage);
    const channels = useUpdaterStore((s) => s.channels);
    const channelId = useUpdaterStore((s) => s.channelId);
    const setChannels = useUpdaterStore((s) => s.setChannels);
    const setChannelId = useUpdaterStore((s) => s.setChannelId);

    useEffect(() => {
        if (!supported) return;
        void listUpdateChannels().then(setChannels);
        void getUpdateChannel().then((id) => {
            if (id) setChannelId(id);
        });
    }, [supported, setChannels, setChannelId]);

    const { loading, run: handleCheck } = useRequest(
        async () => {
            const res = await checkForUpdate();
            if (res.status === 'not-available') message.info(res.note ?? '已是最新版本');
        },
        { manual: true }
    );

    // 切换渠道：主进程校验 + 持久化后，打包态会自动按新渠道检查（事件回流更新状态）。
    const { loading: switching, run: handleChannelChange } = useRequest(
        async (id: string) => {
            const res = await setUpdateChannel(id);
            setChannelId(res.id);
            message.success('已切换更新渠道');
        },
        { manual: true }
    );

    return (
        <div className={cx('app-update-panel', styles.toString())}>
            <div className="app-update-panel-title">关于与更新</div>

            <div className="app-update-panel-row">
                <span className="app-update-panel-label">当前版本</span>
                <Tag>{currentVersion || '—'}</Tag>
            </div>

            {channels.length > 0 && (
                <div className="app-update-panel-row">
                    <span className="app-update-panel-label">更新渠道</span>
                    <Radio.Group
                        optionType="button"
                        value={channelId}
                        disabled={!supported || switching}
                        onChange={(e) => handleChannelChange(e.target.value as string)}
                        options={channels.map((c) => ({ label: c.displayName, value: c.id }))}
                    />
                </div>
            )}

            <div className="app-update-panel-row">
                <Button
                    type="primary"
                    loading={loading || status === 'checking'}
                    disabled={!supported}
                    onClick={handleCheck}
                >
                    检查更新
                </Button>
                {!supported && <span className="app-update-panel-hint">仅桌面打包版支持应用更新</span>}
            </div>

            {status === 'available' && latestVersion && (
                <div className="app-update-panel-row">
                    <span>发现新版本 v{latestVersion}</span>
                    {canAutoInstall ? (
                        <Button size="small" onClick={() => void downloadUpdate()}>
                            下载更新
                        </Button>
                    ) : (
                        <Button size="small" onClick={() => void openReleasePage(releaseUrl)}>
                            前往下载
                        </Button>
                    )}
                </div>
            )}

            {status === 'downloading' && progress && (
                <div className="app-update-panel-row">
                    <Progress percent={progress.percent} size="small" style={{ maxWidth: 240 }} />
                </div>
            )}

            {status === 'downloaded' && (
                <div className="app-update-panel-row">
                    <span>新版本已下载完成</span>
                    <Button size="small" type="primary" onClick={() => void quitAndInstall()}>
                        重启并安装
                    </Button>
                </div>
            )}

            {status === 'not-available' && <div className="app-update-panel-hint">已是最新版本</div>}
            {status === 'error' && errorMessage && (
                <div className="app-update-panel-error">检查更新失败：{errorMessage}</div>
            )}
        </div>
    );
}

export default AppUpdatePanel;
