import { LinkOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Alert, Button, Card, Empty, Popconfirm, Space, Spin, Tag } from 'antd';
import { useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import {
    bindChannelApi,
    fetchChannelsApi,
    startChannelApi,
    stopChannelApi,
    unbindChannelApi,
    type ChannelItem,
    type ChannelStatus
} from '@/services';

import { ChannelBindModal } from './ChannelBindModal';
import useStyles from './styles';

const STATUS_TAG: Record<ChannelStatus, { color: string; text: string }> = {
    running: { color: 'success', text: '运行中' },
    starting: { color: 'processing', text: '启动中' },
    error: { color: 'error', text: '异常' },
    idle: { color: 'default', text: '已停止' }
};

export function ChannelPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [binding, setBinding] = useState<ChannelItem | null>(null);
    const [acting, setActing] = useState<string | null>(null);

    // 挂载即拉取并每 10s 轮询运行态（渠道 monitor 在后端，状态靠拉取同步）；
    // pollingWhenHidden:false — 窗口切到后台时暂停轮询，回到前台再恢复
    const { data, loading, refresh } = useRequest(
        async () => {
            const res = await fetchChannelsApi();
            return res.code === SUCCESS_CODE ? (res.data ?? []) : [];
        },
        { pollingInterval: 10000, pollingWhenHidden: false }
    );

    const channels = data ?? [];
    const hasWeixin = channels.some((c) => c.id === 'weixin');

    const withAction = async (id: string, fn: () => Promise<{ code: number; message?: string }>, okMsg: string) => {
        setActing(id);
        try {
            const res = await fn();
            if (res.code === SUCCESS_CODE) {
                message.success(okMsg);
                refresh();
            }
        } finally {
            setActing(null);
        }
    };

    const handleStart = (ch: ChannelItem) => withAction(ch.id, () => startChannelApi(ch.id), `${ch.name} 已启动`);
    const handleStop = (ch: ChannelItem) => withAction(ch.id, () => stopChannelApi(ch.id), `${ch.name} 已停止`);
    const handleUnbind = (ch: ChannelItem) =>
        withAction(
            ch.id,
            async () => {
                const res = await unbindChannelApi(ch.id);
                return res;
            },
            `${ch.name} 已解绑`
        );

    const handleBound = async (payload: Record<string, string>) => {
        if (!binding) return;
        const res = await bindChannelApi(binding.id, payload);
        if (res.code === SUCCESS_CODE) {
            const info = res.data?.info ?? [];
            if (res.data?.ok) {
                message.success(info[0] || '绑定成功');
                setBinding(null);
                refresh();
            } else {
                message.error(info[0] || '绑定失败');
            }
        }
    };

    return (
        <Spin spinning={loading && channels.length === 0} className={cx('channel-panel', styles.toString())}>
            <div className="channel-panel-toolbar">
                <span className="channel-panel-hint">
                    让智能助手可经 IM 渠道触达。渠道以只读工具集运行（禁 Bash/Write），会话汇入侧栏「渠道」分区。
                </span>
                <Button icon={<ReloadOutlined />} onClick={refresh}>
                    刷新
                </Button>
            </div>

            {!hasWeixin && (
                <Alert
                    className="channel-panel-alert"
                    type="warning"
                    showIcon
                    title="微信渠道未加载（合规卡点）"
                    description="所有渠道均以插件形式加载。个人微信第三方协议存在封号 / 数据合规 / 敏感数据出域风险，请先通过合规评审，再执行 pnpm channels:install-plugins 安装插件，并在 settings.json 的 channels.plugins 里登记 weixin 后重启后端。"
                />
            )}

            {channels.length === 0 && !loading ? (
                <Empty description="暂无已注册渠道" />
            ) : (
                <div className="channel-panel-list">
                    {channels.map((ch) => {
                        const tag = STATUS_TAG[ch.status] ?? STATUS_TAG.idle;
                        const busy = acting === ch.id;
                        return (
                            <Card key={ch.id} size="small" className="channel-panel-card">
                                <div className="channel-panel-card-head">
                                    <span className="channel-panel-card-name">{ch.name}</span>
                                    <Tag color={ch.running ? 'success' : tag.color}>
                                        {ch.running ? '运行中' : tag.text}
                                    </Tag>
                                    {ch.configured ? <Tag color="blue">已配置</Tag> : <Tag color="default">未配置</Tag>}
                                </div>
                                <div className="channel-panel-card-info">
                                    {ch.info.map((line, i) => (
                                        <div key={i}>{line}</div>
                                    ))}
                                </div>
                                <Space wrap>
                                    {ch.running ? (
                                        <Button
                                            icon={<PauseCircleOutlined />}
                                            loading={busy}
                                            onClick={() => handleStop(ch)}
                                        >
                                            停止
                                        </Button>
                                    ) : (
                                        <Button
                                            type="primary"
                                            icon={<PlayCircleOutlined />}
                                            disabled={!ch.configured}
                                            loading={busy}
                                            onClick={() => handleStart(ch)}
                                        >
                                            启动
                                        </Button>
                                    )}
                                    {(ch.supportsBind || ch.supportsQr) && (
                                        <Button
                                            icon={<LinkOutlined />}
                                            disabled={ch.running}
                                            onClick={() => setBinding(ch)}
                                        >
                                            {ch.configured ? '重新绑定' : ch.supportsQr ? '扫码绑定' : '绑定'}
                                        </Button>
                                    )}
                                    {ch.configured && (
                                        <Popconfirm
                                            title={`解绑 ${ch.name}`}
                                            description="将清除该渠道的凭据配置。"
                                            okText="解绑"
                                            cancelText="取消"
                                            okButtonProps={{ danger: true }}
                                            disabled={ch.running}
                                            onConfirm={() => handleUnbind(ch)}
                                        >
                                            <Button danger disabled={ch.running}>
                                                解绑
                                            </Button>
                                        </Popconfirm>
                                    )}
                                </Space>
                            </Card>
                        );
                    })}
                </div>
            )}

            <ChannelBindModal
                channel={binding}
                onCancel={() => setBinding(null)}
                onTokenSubmit={handleBound}
                onSuccess={() => {
                    message.success(`${binding?.name ?? ''} 已绑定`);
                    setBinding(null);
                    refresh();
                }}
            />
        </Spin>
    );
}

export default ChannelPanel;
