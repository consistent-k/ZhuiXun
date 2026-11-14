import { DeleteOutlined, EditOutlined, ExperimentOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Card, Empty, Popconfirm, Select, Space, Spin, Tag } from 'antd';
import { useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import {
    createProviderApi,
    deleteProviderApi,
    fetchModelConfigApi,
    setActiveModelApi,
    testProviderApi,
    updateProviderApi
} from '@/services';
import type { ProviderConfig, ProviderView } from '@/services';

import { ProviderForm } from '../ProviderForm';

const KIND_LABEL: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google Gemini',
    'openai-compatible': 'OpenAI 兼容'
};

export function ModelProviderPanel() {
    const { message } = App.useApp();
    const [formOpen, setFormOpen] = useState(false);
    const [editing, setEditing] = useState<ProviderView | null>(null);
    const [testingName, setTestingName] = useState<string>();

    // 模型配置真源在后端 settings.json：面板挂载时拉取 providers + activeModel
    const { data, loading, refresh } = useRequest(async () => {
        const res = await fetchModelConfigApi();
        return res.code === SUCCESS_CODE ? res.data : undefined;
    });
    const providers = data?.providers ?? [];
    const activeModel = data?.activeModel;
    const activeOptions = providers.flatMap((p) =>
        p.models.map((m) => ({ label: `${p.name} / ${m}`, value: `${p.name}/${m}` }))
    );

    const { run: changeActive, loading: activeSaving } = useRequest(
        async (ref: string) => {
            const res = await setActiveModelApi(ref);
            if (res.code === SUCCESS_CODE) {
                message.success('已切换激活模型');
                refresh();
            }
        },
        { manual: true }
    );

    const handleAdd = () => {
        setEditing(null);
        setFormOpen(true);
    };

    const handleEdit = (p: ProviderView) => {
        setEditing(p);
        setFormOpen(true);
    };

    const handleSubmit = async (values: ProviderConfig) => {
        const res = editing ? await updateProviderApi(editing.name, values) : await createProviderApi(values);
        if (res.code === SUCCESS_CODE) {
            message.success(editing ? '更新成功' : '添加成功');
            setFormOpen(false);
            refresh();
        }
    };

    const handleDelete = async (name: string) => {
        const res = await deleteProviderApi(name);
        if (res.code === SUCCESS_CODE) {
            message.success('已删除');
            refresh();
        }
    };

    const handleTest = async (p: ProviderView) => {
        setTestingName(p.name);
        try {
            const res = await testProviderApi(p.name);
            if (res.code !== SUCCESS_CODE) return;
            if (res.data?.ok) message.success('连接成功');
            else message.error(`连接失败：${res.data?.error || '未知错误'}`);
        } finally {
            setTestingName(undefined);
        }
    };

    return (
        <div className="settings-page-provider-panel">
            <div className="settings-page-toolbar">
                <span className="settings-page-hint">管理模型提供方和本机默认模型</span>
                <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
                    添加提供方
                </Button>
            </div>

            <div className="settings-page-active-row">
                <span className="settings-page-active-label">激活模型</span>
                <Select
                    className="settings-page-active-select"
                    aria-label="激活模型"
                    value={activeModel}
                    options={activeOptions}
                    loading={activeSaving}
                    disabled={activeOptions.length === 0}
                    placeholder={activeOptions.length === 0 ? '请先为提供方添加模型' : '选择激活模型'}
                    onChange={changeActive}
                />
            </div>

            <Spin spinning={loading}>
                {providers.length === 0 && !loading ? (
                    <Empty
                        className="settings-page-empty"
                        description="尚未配置模型提供方"
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                ) : (
                    providers.map((p) => (
                        <Card key={p.name} className="settings-page-server-card" size="small">
                            <div className="settings-page-card-header">
                                <div className="settings-page-card-title">
                                    <LinkOutlined />
                                    {p.name}
                                    <Tag>{KIND_LABEL[p.kind] ?? p.kind}</Tag>
                                    {p.configured ? (
                                        <Tag color="success">已配置密钥</Tag>
                                    ) : (
                                        <Tag color="warning">未配置密钥</Tag>
                                    )}
                                </div>
                                <Space>
                                    <Button
                                        type="text"
                                        size="small"
                                        icon={<ExperimentOutlined />}
                                        loading={testingName === p.name}
                                        onClick={() => handleTest(p)}
                                    >
                                        测试
                                    </Button>
                                    <Button
                                        type="text"
                                        size="small"
                                        icon={<EditOutlined />}
                                        onClick={() => handleEdit(p)}
                                    >
                                        编辑
                                    </Button>
                                    <Popconfirm
                                        title="确定删除此 provider？"
                                        description="删除后若激活模型指向它将一并清空"
                                        onConfirm={() => handleDelete(p.name)}
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
                            <div className="settings-page-card-meta">
                                <span>API 地址: {p.baseURL}</span>
                                <span className="settings-page-model-tags">
                                    {p.models.length > 0 ? (
                                        p.models.map((m) => {
                                            const cw = p.modelMeta?.[m]?.contextWindow;
                                            return (
                                                <Tag
                                                    key={m}
                                                    color={activeModel === `${p.name}/${m}` ? 'processing' : undefined}
                                                >
                                                    {m}
                                                    {cw ? ` · ${cw.toLocaleString()}` : ''}
                                                </Tag>
                                            );
                                        })
                                    ) : (
                                        <span className="settings-page-hint">未添加模型</span>
                                    )}
                                </span>
                            </div>
                        </Card>
                    ))
                )}
            </Spin>

            <ProviderForm
                open={formOpen}
                editingProvider={editing}
                onClose={() => setFormOpen(false)}
                onSubmit={handleSubmit}
            />
        </div>
    );
}

export default ModelProviderPanel;
