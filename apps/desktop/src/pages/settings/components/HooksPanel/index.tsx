import { ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Empty, Popconfirm, Spin, Switch, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchHookAuditApi, fetchHooksApi, updateHooksTrustApi } from '@/services';
import type { HookAuditEntry, HooksStatus } from '@/types/hooks';
import dayjs from '@/utils/dayjs';

import useStyles from './styles';

const STATUS_META: Record<HooksStatus, { label: string; color: string }> = {
    absent: { label: '未配置', color: 'default' },
    error: { label: '解析错误', color: 'red' },
    untrusted: { label: '待信任', color: 'orange' },
    disabled: { label: '已停用', color: 'default' },
    active: { label: '已启用', color: 'green' }
};

const DECISION_COLOR: Record<string, string> = { deny: 'red', ask: 'orange', allow: 'green', error: 'red' };

const columns: ColumnsType<HookAuditEntry> = [
    {
        title: '时间',
        dataIndex: 'ts',
        width: 160,
        render: (ts: string) => dayjs(ts).format('MM-DD HH:mm:ss')
    },
    {
        title: '事件',
        dataIndex: 'event',
        width: 120,
        render: (event: string, row) => (
            <span>
                {event}
                {row.toolName ? ` · ${row.toolName}` : ''}
            </span>
        )
    },
    { title: '命令', dataIndex: 'command', render: (cmd: string) => <code className="hooks-panel-code">{cmd}</code> },
    {
        title: '结果',
        key: 'result',
        width: 150,
        render: (_: unknown, row) => (
            <span>
                <Tag color={DECISION_COLOR[row.decision]}>{row.decision}</Tag>
                <span className="hooks-panel-meta">
                    {row.timedOut ? '超时' : `退出 ${row.exitCode ?? '-'}`} · {row.durationMs}ms
                </span>
            </span>
        )
    }
];

/**
 * 设置页「Hooks」：hooks.json 仅手工编辑，这里只读展示配置与状态、信任当前 hash、切换总开关，并列出最近执行记录。
 */
export function HooksPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();

    const {
        data: view,
        loading,
        mutate,
        refresh
    } = useRequest(async () => {
        const res = await fetchHooksApi();
        return res.code === SUCCESS_CODE ? res.data : undefined;
    });
    const { data: audit, refresh: refreshAudit } = useRequest(async () => {
        const res = await fetchHookAuditApi(50);
        return res.code === SUCCESS_CODE ? res.data : [];
    });

    const handleTrust = async () => {
        if (!view?.hash) return;
        const res = await updateHooksTrustApi({ hash: view.hash });
        if (res.code === SUCCESS_CODE && res.data) {
            mutate(res.data);
            message.success('已信任当前配置');
        } else {
            // 409：文件已变化，刷新后让用户重新审阅（错误提示由拦截器弹出）
            refresh();
        }
    };

    const handleToggle = async (enabled: boolean) => {
        const res = await updateHooksTrustApi({ enabled });
        if (res.code === SUCCESS_CODE && res.data) {
            mutate(res.data);
            message.success(enabled ? '已开启 Hooks' : '已关闭 Hooks');
        }
    };

    const status = view ? STATUS_META[view.status] : undefined;
    const canTrust = !!view?.hash && !view.trusted && view.status !== 'error';

    return (
        <Spin spinning={loading} className={cx('hooks-panel', styles.toString())}>
            <div className="hooks-panel-row">
                <div>
                    <div className="hooks-panel-title">
                        Hooks {status && <Tag color={status.color}>{status.label}</Tag>}
                    </div>
                    <div className="hooks-panel-hint">
                        在工具调用前后、回答结束时以本机 shell 执行命令（如格式化、lint、通知）。配置文件仅可手工编辑，
                        内容变化后需重新信任才会执行。
                    </div>
                </div>
                <Switch checked={view?.enabled ?? false} onChange={handleToggle} disabled={!view} />
            </div>

            <div className="hooks-panel-path">
                配置文件：<code className="hooks-panel-code">{view?.path ?? '-'}</code>
                <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={() => {
                        refresh();
                        refreshAudit();
                    }}
                >
                    刷新
                </Button>
            </div>

            {view?.error && <Alert className="hooks-panel-alert" type="error" showIcon title={view.error} />}
            {view?.status === 'untrusted' && (
                <Alert
                    className="hooks-panel-alert"
                    type="warning"
                    showIcon
                    title="配置未被信任，当前不会执行任何 hook"
                    description="请先审阅下方完整内容，确认每条命令都是你预期的，再点「信任当前配置」。"
                    action={
                        canTrust && (
                            <Popconfirm
                                title="信任当前配置？"
                                description="hook 将以本机 shell 执行任意命令，并能读到工具入参与产出。"
                                okText="信任"
                                cancelText="取消"
                                onConfirm={handleTrust}
                            >
                                <Button size="small" type="primary" icon={<SafetyCertificateOutlined />}>
                                    信任当前配置
                                </Button>
                            </Popconfirm>
                        )
                    }
                />
            )}

            {view?.content !== undefined ? (
                <>
                    <div className="hooks-panel-section">
                        配置内容
                        {view.counts && (
                            <span className="hooks-panel-meta">
                                PreToolUse {view.counts.PreToolUse} · PostToolUse {view.counts.PostToolUse} · Stop{' '}
                                {view.counts.Stop}
                            </span>
                        )}
                    </div>
                    <pre className="hooks-panel-content">{view.content}</pre>
                </>
            ) : (
                view?.status === 'absent' && (
                    <Empty description="尚未创建 hooks.json" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )
            )}

            <div className="hooks-panel-section">最近执行记录</div>
            <Table
                size="small"
                rowKey={(row) => `${row.ts}-${row.command}-${row.event}`}
                columns={columns}
                dataSource={audit ?? []}
                pagination={false}
                locale={{ emptyText: <Empty description="暂无执行记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
        </Spin>
    );
}

export default HooksPanel;
