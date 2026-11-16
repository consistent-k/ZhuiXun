import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Empty, Flex, Form, Input, Listy, Popconfirm, Select, Space, Spin, Tag, Typography } from 'antd';
import { useState } from 'react';

import Modal from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { deleteMemoryItemApi, fetchMemoryApi, fetchMemoryItemApi, upsertMemoryItemApi } from '@/services';
import type { MemoryManifestItem, MemoryScope, MemoryType } from '@/types/memory';

import useStyles from './styles';

const TYPE_LABEL: Record<MemoryType, string> = {
    user: '画像',
    feedback: '偏好',
    project: '项目',
    reference: '资源'
};
const TYPE_OPTIONS = (Object.keys(TYPE_LABEL) as MemoryType[]).map((v) => ({ value: v, label: TYPE_LABEL[v] }));

interface MemoryFormValues {
    name: string;
    type: MemoryType;
    description: string;
    content: string;
}

interface MemoryItemsProps {
    /** 记忆作用域：global=全局画像；project=项目专属 */
    scope: MemoryScope;
    /** scope=project 时的项目 id（必填） */
    projectId?: string;
}

/**
 * 记忆条目管理（列表 + 增删改 + 编辑弹窗），按 scope/projectId 作用于某一层记忆。
 * 全局开关（开启记忆/自动沉淀/自动整理）是全局维度，不在本组件内，仍由全局设置页管理。
 */
export function MemoryItems({ scope, projectId }: MemoryItemsProps) {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [editorOpen, setEditorOpen] = useState(false);
    const [creating, setCreating] = useState(true);
    const [editName, setEditName] = useState('');
    const [saving, setSaving] = useState(false);
    const [form] = Form.useForm<MemoryFormValues>();

    const disabled = scope === 'project' && !projectId;
    const itemScopeArgs = scope === 'project' ? { scope, projectId } : { scope };

    const { data, loading, refresh } = useRequest(
        async () => {
            if (disabled) return undefined;
            const res = await fetchMemoryApi(itemScopeArgs);
            return res.code === SUCCESS_CODE ? res.data : undefined;
        },
        { refreshDeps: [scope, projectId] }
    );

    const items = data?.items ?? [];

    const openCreate = () => {
        setCreating(true);
        setEditName('');
        form.resetFields();
        setEditorOpen(true);
    };

    const openEdit = async (it: MemoryManifestItem) => {
        const res = await fetchMemoryItemApi({ ...itemScopeArgs, name: it.name });
        const r = res.code === SUCCESS_CODE ? res.data : undefined;
        setCreating(false);
        setEditName(it.name);
        form.setFieldsValue({
            name: it.name,
            type: r?.type ?? it.type ?? 'user',
            description: r?.description ?? it.description ?? '',
            content: r?.content ?? ''
        });
        setEditorOpen(true);
    };

    const closeEditor = () => setEditorOpen(false);

    const handleSave = async (values: MemoryFormValues) => {
        setSaving(true);
        try {
            const res = await upsertMemoryItemApi({
                ...itemScopeArgs,
                name: values.name.trim(),
                type: values.type,
                description: values.description ?? '',
                content: values.content ?? ''
            });
            if (res.code === SUCCESS_CODE) {
                message.success('记忆已保存');
                setEditorOpen(false);
                refresh();
            }
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (name: string) => {
        const res = await deleteMemoryItemApi({ ...itemScopeArgs, name });
        if (res.code === SUCCESS_CODE) {
            message.success('已删除');
            refresh();
        }
    };

    return (
        <Spin spinning={loading} className={cx('memory-items', styles.toString())}>
            <div className="memory-items-toolbar">
                <Button type="primary" icon={<PlusOutlined />} disabled={disabled} onClick={openCreate}>
                    新建记忆
                </Button>
            </div>

            {disabled ? (
                <Empty className="memory-items-empty" description="无可用项目" />
            ) : items.length === 0 ? (
                <Empty className="memory-items-empty" description="暂无记忆，点击「新建记忆」添加" />
            ) : (
                <Listy
                    className="memory-items-list"
                    items={items}
                    rowKey="name"
                    rowHoverable={false}
                    styles={{ item: { paddingInline: 0 } }}
                    itemRender={(it) => (
                        <Flex justify="space-between" align="center" gap="small">
                            <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                                <div>
                                    {it.name}
                                    {it.type && <Tag className="memory-items-tag">{TYPE_LABEL[it.type]}</Tag>}
                                </div>
                                <Typography.Text type="secondary">{it.description || '（无描述）'}</Typography.Text>
                            </div>
                            <Space size="small" style={{ flexShrink: 0 }}>
                                <Button
                                    type="text"
                                    size="small"
                                    icon={<EditOutlined />}
                                    aria-label="编辑记忆"
                                    onClick={() => openEdit(it)}
                                />
                                <Popconfirm title="删除这条记忆？" onConfirm={() => handleDelete(it.name)}>
                                    <Button
                                        type="text"
                                        size="small"
                                        danger
                                        icon={<DeleteOutlined />}
                                        aria-label="删除记忆"
                                    />
                                </Popconfirm>
                            </Space>
                        </Flex>
                    )}
                />
            )}

            <Modal
                title={creating ? '新建记忆' : `编辑记忆 · ${editName}`}
                open={editorOpen}
                onCancel={closeEditor}
                onOk={() => form.submit()}
                confirmLoading={saving}
            >
                <Form form={form} layout="vertical" initialValues={{ type: 'user' }} onFinish={handleSave}>
                    <Form.Item
                        label="名称"
                        name="name"
                        rules={[
                            { required: true, message: '请填写名称' },
                            { pattern: /^[a-zA-Z0-9._-]+$/, message: '仅支持英文、数字与 . _ -' }
                        ]}
                    >
                        <Input disabled={!creating} placeholder="kebab-case 英文标识，如 call-me-by-name" />
                    </Form.Item>
                    <Form.Item label="类型" name="type" rules={[{ required: true, message: '请选择类型' }]}>
                        <Select options={TYPE_OPTIONS} />
                    </Form.Item>
                    <Form.Item label="描述" name="description">
                        <Input placeholder="一行摘要，用于召回相关性判断" />
                    </Form.Item>
                    <Form.Item label="正文" name="content">
                        <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} placeholder="记忆正文，简洁要点" />
                    </Form.Item>
                </Form>
            </Modal>
        </Spin>
    );
}

export default MemoryItems;
