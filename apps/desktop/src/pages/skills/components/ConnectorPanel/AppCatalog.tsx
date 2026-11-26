import { CloudOutlined, LinkOutlined, SearchOutlined, VideoCameraOutlined } from '@ant-design/icons';
import type { ConnectorApp, ConnectorStatus } from '@zhuixun/shared';
import { useRequest } from 'ahooks';
import { Button, Empty, Form, Input, Popconfirm, Segmented, Space, Spin, Tag } from 'antd';
import { useEffect, useRef, useState } from 'react';

import Modal from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import {
    connectorActionApi,
    fetchConnectorCatalogApi,
    fetchConnectorConnectionsApi,
    type ConnectorAction
} from '@/services';

const labels: Record<ConnectorStatus, string> = {
    'not-installed': '未安装组件',
    installing: '正在安装',
    disconnected: '未连接',
    authorizing: '等待授权',
    connected: '已连接',
    disabled: '已停用',
    failed: '连接失败'
};

/** MCP 与 CLI 共用配置驱动的连接弹窗；自定义 MCP 仍由父面板独立管理。 */
export function AppCatalog({ refresh }: { refresh: () => void }) {
    const [form] = Form.useForm<Record<string, string>>();
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('全部');
    const [selected, setSelected] = useState<ConnectorApp | null>(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const openedUrl = useRef('');
    const {
        data: apps = [],
        loading: catalogLoading,
        error: catalogError,
        refresh: reloadCatalog
    } = useRequest(async () => {
        const res = await fetchConnectorCatalogApi();
        if (res.code !== SUCCESS_CODE) throw new Error('目录加载失败');
        return res.data ?? [];
    });
    const {
        data: connections = [],
        loading,
        error,
        refresh: reloadConnections,
        refreshAsync
    } = useRequest(async () => {
        const res = await fetchConnectorConnectionsApi();
        if (res.code !== SUCCESS_CODE) throw new Error('连接状态加载失败');
        return res.data ?? [];
    });
    const pending = connections.some((item) => item.status === 'installing' || item.status === 'authorizing');
    useEffect(() => {
        if (!pending || error) return;
        const timer = setInterval(reloadConnections, 2000);
        return () => clearInterval(timer);
    }, [pending, error, reloadConnections]);
    const connection = connections.find((item) => item.id === selected?.id);
    const needsInstall = selected?.kind === 'cli' && !connection?.installed;
    const connected = connection?.status === 'connected';
    const working = connection?.status === 'installing' || connection?.status === 'authorizing';
    const url = connection?.authorizationUrl;
    useEffect(() => {
        if (url && url !== openedUrl.current) {
            openedUrl.current = url;
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }, [url]);
    const open = (app: ConnectorApp) => {
        form.resetFields();
        form.setFieldsValue(Object.fromEntries(app.fields.map((field) => [field.key, field.defaultValue ?? ''])));
        openedUrl.current = '';
        setFeedback('');
        setSelected(app);
    };
    const act = async (action: ConnectorAction) => {
        if (!selected || busy) return;
        const values =
            action === 'connect' && selected.fields.length ? await form.validateFields().catch(() => null) : undefined;
        if (values === null) return;
        setBusy(true);
        setFeedback('');
        openedUrl.current = '';
        try {
            let res = await connectorActionApi(selected.id, action, values ? { values } : undefined);
            if (res.code !== SUCCESS_CODE) {
                setFeedback(res.message ?? '操作失败，请重试');
                return;
            }
            if (action === 'connect' && selected.auth === 'oauth' && res.data?.status !== 'connected') {
                res = await connectorActionApi(selected.id, 'auth', { force: !!connection?.configured });
                if (res.code !== SUCCESS_CODE) {
                    setFeedback(res.message ?? '授权未完成，请重试');
                    return;
                }
            }
            if (res.data?.status !== 'failed') form.resetFields();
            if (res.data?.authorizationUrl) {
                openedUrl.current = res.data.authorizationUrl;
                window.open(res.data.authorizationUrl, '_blank', 'noopener,noreferrer');
            }
            if (res.data?.status === 'failed') setFeedback(res.data.error ?? '连接失败，请重试');
            else if (action === 'disconnect') setFeedback('已清除本地连接。服务方授权由对应应用管理。');
            else if (res.data?.status === 'connected') setFeedback('已连接，新对话可使用该应用。');
            await refreshAsync();
            refresh();
        } finally {
            setBusy(false);
        }
    };
    const visible = apps.filter(
        (app) =>
            `${app.name} ${app.description} ${app.category}`.toLowerCase().includes(query.trim().toLowerCase()) &&
            (filter === '全部' || connections.some((item) => item.id === app.id && item.status === 'connected'))
    );
    return (
        <>
            <div className="connector-catalog-tools">
                <Input
                    className="connector-catalog-search"
                    prefix={<SearchOutlined />}
                    placeholder="搜索应用、能力…"
                    aria-label="搜索应用"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    allowClear
                />
                <Segmented options={['全部', '已连接']} value={filter} onChange={setFilter} />
            </div>
            <Spin spinning={catalogLoading || (loading && !connections.length)}>
                {catalogError || error ? (
                    <Empty description="连接器加载失败">
                        <Button
                            onClick={() => {
                                reloadCatalog();
                                reloadConnections();
                            }}
                        >
                            重新加载
                        </Button>
                    </Empty>
                ) : !visible.length ? (
                    <Empty description="没有匹配的应用" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                    <div className="connector-catalog-grid">
                        {visible.map((app) => {
                            const state = connections.find((item) => item.id === app.id);
                            return (
                                <article key={app.id} className="connector-app-card">
                                    <div className="connector-app-card-top">
                                        <span
                                            className={`connector-app-icon connector-app-icon-${app.id}`}
                                            aria-hidden="true"
                                        >
                                            {app.id === 'baidu-netdisk' ? (
                                                <CloudOutlined />
                                            ) : app.kind === 'cli' ? (
                                                <VideoCameraOutlined />
                                            ) : (
                                                app.name[0]
                                            )}
                                        </span>
                                        <Tag>{app.category}</Tag>
                                    </div>
                                    <h3>{app.name}</h3>
                                    <p>{app.description}</p>
                                    <div className="connector-app-card-bottom">
                                        <span
                                            className={
                                                state?.status === 'connected'
                                                    ? 'connector-app-ready'
                                                    : 'connector-panel-hint'
                                            }
                                        >
                                            {state?.configured ||
                                            state?.status === 'installing' ||
                                            state?.status === 'authorizing' ||
                                            state?.status === 'failed'
                                                ? labels[state.status]
                                                : app.kind === 'cli'
                                                  ? '安装后授权'
                                                  : app.auth === 'oauth'
                                                    ? '浏览器授权'
                                                    : app.auth === 'none'
                                                      ? '直接连接'
                                                      : '填写凭证'}
                                        </span>
                                        <Button icon={<LinkOutlined />} onClick={() => open(app)}>
                                            {state?.configured ||
                                            state?.status === 'installing' ||
                                            state?.status === 'authorizing'
                                                ? '管理'
                                                : '连接'}
                                        </Button>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}
            </Spin>
            <Modal
                title={selected ? `${selected.name}${connection?.configured ? '连接管理' : '连接'}` : '连接应用'}
                open={!!selected}
                width={480}
                onCancel={() => {
                    if (!busy) {
                        setSelected(null);
                        form.resetFields();
                    }
                }}
                closable={!busy}
                mask={{ closable: !busy }}
                footer={
                    selected && (
                        <Space wrap>
                            {working && (
                                <Button disabled={busy} onClick={() => act('disable')}>
                                    取消连接
                                </Button>
                            )}
                            {connection?.configured && !working && (
                                <>
                                    <Button
                                        disabled={busy}
                                        onClick={() => act(connection.enabled ? 'disable' : 'enable')}
                                    >
                                        {connection.enabled ? '暂停使用' : '启用'}
                                    </Button>
                                    <Popconfirm
                                        title="断开连接并清除本地凭证？"
                                        okText="断开"
                                        cancelText="取消"
                                        onConfirm={() => act('disconnect')}
                                    >
                                        <Button danger disabled={busy}>
                                            断开连接
                                        </Button>
                                    </Popconfirm>
                                </>
                            )}
                            {!connected && !working && connection?.status !== 'disabled' && (
                                <Button
                                    type="primary"
                                    loading={busy}
                                    onClick={() => act(needsInstall ? 'install' : 'connect')}
                                >
                                    {needsInstall
                                        ? '安装组件'
                                        : selected.auth === 'oauth' || selected.auth === 'cli'
                                          ? '授权连接'
                                          : '连接'}
                                </Button>
                            )}
                        </Space>
                    )
                }
            >
                {selected && (
                    <Form form={form} layout="vertical" preserve={false} onFinish={() => void act('connect')}>
                        {connection?.configured || working || connection?.status === 'failed' ? (
                            <p role="status">
                                {labels[connection!.status]}
                                {connected && connection?.toolCount ? ` · ${connection.toolCount} 个工具` : ''}
                            </p>
                        ) : null}
                        {connection?.error && <p role="alert">{connection.error}</p>}
                        {!connected &&
                            !working &&
                            connection?.status !== 'disabled' &&
                            selected.fields.map((field) => (
                                <Form.Item
                                    key={field.key}
                                    name={field.key}
                                    label={field.label}
                                    rules={[
                                        { required: field.required, whitespace: true, message: `请填写${field.label}` }
                                    ]}
                                >
                                    {field.type === 'password' ? (
                                        <Input.Password
                                            autoComplete="off"
                                            disabled={busy}
                                            placeholder={field.placeholder}
                                        />
                                    ) : (
                                        <Input autoComplete="off" disabled={busy} placeholder={field.placeholder} />
                                    )}
                                </Form.Item>
                            ))}
                        {!connected && !working && selected.credentialUrl && (
                            <p>
                                <a href={selected.credentialUrl} target="_blank" rel="noreferrer">
                                    获取授权凭证 ↗
                                </a>
                            </p>
                        )}
                        {!connected && needsInstall && <p>将安装官方应用组件到追寻专用目录。</p>}
                        {url && (
                            <p>
                                <a href={url} target="_blank" rel="noreferrer">
                                    打开授权页面 ↗
                                </a>
                            </p>
                        )}
                        {selected.kind === 'cli' && !needsInstall && !working && (
                            <Button size="small" type="text" disabled={busy} onClick={() => act('refresh')}>
                                检查连接状态
                            </Button>
                        )}
                        {feedback && <p role="status">{feedback}</p>}
                    </Form>
                )}
            </Modal>
        </>
    );
}
