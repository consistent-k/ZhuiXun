import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { clearCache, useRequest } from 'ahooks';
import { App, Button, Empty, Form, Input, Popconfirm, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { Modal } from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { deleteCommandApi, fetchCommandApi, fetchCommandsApi, saveCommandApi } from '@/services';
import type { CommandSummary } from '@/types/command';

import useStyles from './styles';

interface CommandFormValues {
    name: string;
    description?: string;
    argumentHint?: string;
    body: string;
}

/** 与输入框联想共用的缓存键：保存 / 删除后清缓存，回到对话页即刷新。 */
const SUGGESTION_CACHE_KEY = 'slash-commands';

/**
 * 设置页「命令」：管理自定义 slash 命令宏（`~/.zhuixun/commands/<name>.md`）。
 * 模板支持 `$ARGUMENTS`（全部参数）与 `$1`…`$9`（按位参数）；内置命令只读展示。
 */
export function CommandPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [form] = Form.useForm<CommandFormValues>();
    const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; name?: string } | null>(null);
    const [saving, setSaving] = useState(false);

    const { data, loading, refresh } = useRequest(async () => {
        const res = await fetchCommandsApi();
        return res.code === SUCCESS_CODE ? res.data : undefined;
    });

    const openCreate = () => {
        form.resetFields();
        setEditing({ mode: 'create' });
    };

    const openEdit = async (name: string) => {
        const res = await fetchCommandApi(name);
        if (res.code !== SUCCESS_CODE || !res.data) return;
        form.setFieldsValue(res.data);
        setEditing({ mode: 'edit', name });
    };

    const afterChange = () => {
        clearCache(SUGGESTION_CACHE_KEY);
        refresh();
    };

    const handleSave = async () => {
        let values: CommandFormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        setSaving(true);
        try {
            const res = await saveCommandApi(values.name, {
                description: values.description,
                argumentHint: values.argumentHint,
                body: values.body
            });
            if (res.code !== SUCCESS_CODE) return;
            message.success(editing?.mode === 'edit' ? '命令已更新' : '命令已创建');
            setEditing(null);
            afterChange();
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (name: string) => {
        const res = await deleteCommandApi(name);
        if (res.code === SUCCESS_CODE) {
            message.success('命令已删除');
            afterChange();
        }
    };

    const nameColumn = {
        title: '命令',
        dataIndex: 'name',
        render: (name: string, row: CommandSummary) => (
            <span>
                <code className="command-panel-name">/{name}</code>
                {row.argumentHint && <span className="command-panel-meta">{row.argumentHint}</span>}
            </span>
        )
    };
    const descColumn = { title: '说明', dataIndex: 'description', render: (d?: string) => d || '-' };

    const userColumns: ColumnsType<CommandSummary> = [
        nameColumn,
        descColumn,
        {
            title: '操作',
            key: 'action',
            width: 120,
            render: (_: unknown, row) => (
                <span>
                    <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        aria-label="编辑命令"
                        onClick={() => void openEdit(row.name)}
                    />
                    <Popconfirm
                        title={`删除 /${row.name}？`}
                        onConfirm={() => handleDelete(row.name)}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                    >
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除命令" />
                    </Popconfirm>
                </span>
            )
        }
    ];

    return (
        <Spin spinning={loading} className={cx('command-panel', styles.toString())}>
            <div className="command-panel-toolbar">
                <span className="command-panel-hint">
                    在输入框输入 <code>/命令名 参数</code>{' '}
                    即可把模板展开为完整提示词发送；命令只是提示词模板，不会执行任何程序。
                </span>
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                    新建命令
                </Button>
            </div>
            <Table
                size="small"
                rowKey="name"
                columns={userColumns}
                dataSource={data?.user ?? []}
                pagination={false}
                locale={{ emptyText: <Empty description="暂无自定义命令" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />

            <div className="command-panel-section">
                内置命令 <Tag>只读</Tag>
            </div>
            <Table
                size="small"
                rowKey="name"
                columns={[nameColumn, descColumn]}
                dataSource={data?.builtin ?? []}
                pagination={false}
            />

            <Modal
                className={cx('command-panel-modal', styles.toString())}
                title={editing?.mode === 'edit' ? `编辑 /${editing.name}` : '新建命令'}
                open={!!editing}
                confirmLoading={saving}
                onOk={handleSave}
                onCancel={() => setEditing(null)}
            >
                <Form form={form} layout="vertical">
                    <Form.Item
                        name="name"
                        label="命令名"
                        extra="小写字母、数字与连字符，1–32 位；不能与内置命令 new / help / compact 重名"
                        rules={[
                            { required: true, message: '请输入命令名' },
                            {
                                pattern: /^[a-z0-9][a-z0-9-]{0,31}$/,
                                message: '只能包含小写字母、数字与连字符，且以字母或数字开头'
                            }
                        ]}
                    >
                        <Input prefix="/" placeholder="review" disabled={editing?.mode === 'edit'} autoComplete="off" />
                    </Form.Item>
                    <Form.Item name="description" label="说明">
                        <Input placeholder="审查指定文件的代码质量" maxLength={200} />
                    </Form.Item>
                    <Form.Item name="argumentHint" label="参数提示">
                        <Input placeholder="<文件路径>" maxLength={200} />
                    </Form.Item>
                    <Form.Item
                        name="body"
                        label="模板正文"
                        extra="$ARGUMENTS 替换为全部参数，$1…$9 为按空白切分的第 N 个参数（支持引号）；没有占位符时参数追加到末尾。"
                        rules={[{ required: true, whitespace: true, message: '请输入模板正文' }]}
                    >
                        <Input.TextArea
                            className="command-panel-body"
                            autoSize={{ minRows: 6, maxRows: 16 }}
                            maxLength={20000}
                            placeholder={'请审查 $1 的代码：\n1. 找出潜在 bug\n2. 给出修改建议'}
                        />
                    </Form.Item>
                </Form>
            </Modal>
        </Spin>
    );
}

export default CommandPanel;
