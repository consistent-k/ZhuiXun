import {
    CloudServerOutlined,
    DeleteOutlined,
    EditOutlined,
    KeyOutlined,
    PauseCircleOutlined,
    PlayCircleOutlined,
    PlusOutlined,
    ReloadOutlined,
    ToolOutlined
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Card, Empty, Popconfirm, Space, Spin, Switch, Tag } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import {
    addMCPServerApi,
    deleteMCPServerApi,
    fetchMCPServersApi,
    reconnectMCPServerApi,
    startMCPServerAuthApi,
    toggleMCPServerApi,
    updateMCPServerApi
} from '@/services';
import { colors } from '@/theme/tokens';
import type { MCPServerItem } from '@/types/mcp';

import { McpServerForm } from '../McpServerForm';

import useStyles from './styles';

const statusColorMap: Record<string, string> = {
    connected: 'success',
    failed: 'error',
    disconnected: 'default',
    reconnecting: 'processing'
};

const statusLabelMap: Record<string, string> = {
    connected: '已连接',
    failed: '连接失败',
    disconnected: '未连接',
    reconnecting: '重连中'
};

/** 连接器（MCP 服务）管理面板：列表 / 添加 / 编辑 / 重连 / 启停 / OAuth 授权 */
export function ConnectorPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [formOpen, setFormOpen] = useState(false);
    const [editingServer, setEditingServer] = useState<MCPServerItem | null>(null);
    // OAuth 授权轮询定时器：存 ref 以便在授权完成 / 组件卸载时清理，
    // 否则离开面板后 interval 仍每 3s 触发 fetch + setState（对已卸载组件）最多 60s。
    const authPollRef = useRef<{ interval?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout> }>(
        {}
    );

    const clearAuthPoll = useCallback(() => {
        if (authPollRef.current.interval) clearInterval(authPollRef.current.interval);
        if (authPollRef.current.timeout) clearTimeout(authPollRef.current.timeout);
        authPollRef.current = {};
    }, []);

    useEffect(() => clearAuthPoll, [clearAuthPoll]);

    const {
        data: servers = [],
        loading,
        refresh: loadServers
    } = useRequest(async () => {
        const res = await fetchMCPServersApi();
        return res.code === SUCCESS_CODE ? (res.data ?? []) : [];
    });

    const handleAdd = () => {
        setEditingServer(null);
        setFormOpen(true);
    };

    const handleEdit = (server: MCPServerItem) => {
        setEditingServer(server);
        setFormOpen(true);
    };

    const handleFormSubmit = async (values: Omit<MCPServerItem, 'status' | 'error' | 'toolCount'>) => {
        const res = editingServer
            ? await updateMCPServerApi(editingServer.name, values)
            : await addMCPServerApi(values);
        if (res.code === SUCCESS_CODE) {
            message.success(editingServer ? '更新成功' : '添加成功');
            setFormOpen(false);
            loadServers();
        }
    };

    const handleDelete = async (name: string) => {
        const res = await deleteMCPServerApi(name);
        if (res.code === SUCCESS_CODE) {
            message.success('已删除');
            loadServers();
        }
    };

    const handleReconnect = async (name: string) => {
        const res = await reconnectMCPServerApi(name);
        if (res.code === SUCCESS_CODE) {
            if (res.data?.status === 'connected') {
                message.success(`${name} 重连成功`);
            } else {
                message.warning(`${name} 重连失败: ${res.data?.error || '未知错误'}`);
            }
            loadServers();
        }
    };

    const handleToggle = async (name: string) => {
        const res = await toggleMCPServerApi(name);
        if (res.code === SUCCESS_CODE) {
            message.success(`${name} ${res.data?.disabled ? '已禁用' : '已启用'}，需重开会话后生效`, 4);
            loadServers();
        }
    };

    const handleAuth = async (name: string) => {
        const res = await startMCPServerAuthApi(name);
        if (res.code !== SUCCESS_CODE) return;
        const result = res.data;
        if (result?.authenticated) {
            message.success(`${name} 已授权`);
            loadServers();
            return;
        }
        if (result?.authorizationUrl) {
            window.open(result.authorizationUrl, '_blank');
            message.info('请在浏览器中完成授权，完成后此页面将自动更新');
            // 复用前先清掉可能已有的一轮轮询，避免叠加多个 interval
            clearAuthPoll();
            authPollRef.current.interval = setInterval(async () => {
                const d = await fetchMCPServersApi();
                if (d.code !== SUCCESS_CODE) return;
                const s = d.data?.find((x) => x.name === name);
                if (s?.authenticated || s?.status === 'connected') {
                    clearAuthPoll();
                    message.success(`${name} 授权成功`);
                    loadServers();
                }
            }, 3000);
            authPollRef.current.timeout = setTimeout(() => clearAuthPoll(), 60_000);
        }
    };

    return (
        <div className={cx('connector-panel', styles.toString())}>
            <div className="connector-panel-toolbar">
                <span className="connector-panel-hint">连接器即 MCP 服务，共 {servers.length} 个</span>
                <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
                    添加连接器
                </Button>
            </div>
            <Spin spinning={loading}>
                {servers.length === 0 && !loading ? (
                    <Empty description="暂无连接器（MCP 服务）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                    servers.map((server) => (
                        <Card
                            key={server.name}
                            className="connector-panel-server-card"
                            size="small"
                            style={server.disabled ? { opacity: 0.6 } : undefined}
                        >
                            <div className="connector-panel-card-header">
                                <div className="connector-panel-card-title">
                                    <CloudServerOutlined />
                                    {server.name}
                                    {server.disabled ? (
                                        <Tag color="default">已禁用</Tag>
                                    ) : (
                                        <Tag color={statusColorMap[server.status]}>{statusLabelMap[server.status]}</Tag>
                                    )}
                                </div>
                                <Space>
                                    {server.authType === 'oauth' && (
                                        <Button
                                            type="text"
                                            size="small"
                                            icon={<KeyOutlined />}
                                            onClick={() => handleAuth(server.name)}
                                            style={
                                                server.authenticated
                                                    ? { color: colors.success }
                                                    : { color: colors.warning }
                                            }
                                        >
                                            {server.authenticated ? '已授权' : '授权'}
                                        </Button>
                                    )}
                                    <Switch
                                        size="small"
                                        checked={!server.disabled}
                                        onChange={() => handleToggle(server.name)}
                                        checkedChildren={<PlayCircleOutlined />}
                                        unCheckedChildren={<PauseCircleOutlined />}
                                    />
                                    <Button
                                        type="text"
                                        size="small"
                                        icon={<ReloadOutlined />}
                                        onClick={() => handleReconnect(server.name)}
                                        disabled={server.disabled || server.status === 'connected'}
                                    >
                                        重连
                                    </Button>
                                    <Button
                                        type="text"
                                        size="small"
                                        icon={<EditOutlined />}
                                        onClick={() => handleEdit(server)}
                                    >
                                        编辑
                                    </Button>
                                    <Popconfirm
                                        title="确定删除此连接器？"
                                        description="删除后将断开连接并移除配置"
                                        onConfirm={() => handleDelete(server.name)}
                                        okText="删除"
                                        cancelText="取消"
                                        okButtonProps={{ danger: true }}
                                    >
                                        <Button type="text" size="small" danger icon={<DeleteOutlined />}>
                                            删除
                                        </Button>
                                    </Popconfirm>
                                </Space>
                            </div>
                            <div className="connector-panel-card-meta">
                                <span>传输: {server.transport}</span>
                                {server.authType === 'oauth' && (
                                    <span>认证: OAuth{server.authenticated ? ' (已授权)' : ' (未授权)'}</span>
                                )}
                                {server.transport === 'stdio' && server.command && <span>命令: {server.command}</span>}
                                {(server.transport === 'sse' || server.transport === 'streamableHttp') &&
                                    server.url && <span>URL: {server.url}</span>}
                                <span className="connector-panel-tool-badge">
                                    <ToolOutlined />
                                    {server.toolCount} 个工具
                                </span>
                                {server.error && <span className="connector-panel-error">{server.error}</span>}
                            </div>
                        </Card>
                    ))
                )}
            </Spin>
            <McpServerForm
                open={formOpen}
                editingServer={editingServer}
                onClose={() => setFormOpen(false)}
                onSubmit={handleFormSubmit}
            />
        </div>
    );
}

export default ConnectorPanel;
