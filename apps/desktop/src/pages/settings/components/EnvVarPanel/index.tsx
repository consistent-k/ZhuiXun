import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Empty, Form, Input, Popconfirm, Spin, Tag } from 'antd';
import { useState } from 'react';

import Modal from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { listEnvApi, removeEnvVarApi, setEnvVarApi } from '@/services';

import useStyles from './styles';

/** 环境变量键名：大写字母开头，仅大写字母/数字/下划线（与后端 ENV_KEY_RULE 对齐）。 */
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

interface EnvFormValues {
    key: string;
    value: string;
}

/**
 * 环境变量通用配置面板：统一管理 settings.json 的 env 段（技能/脚本/MCP 经 process.env 读取）。
 * 出于安全，后端只回键名、不下发值；此处列表显示键名 +「已配置」，修改即覆盖、不回显原值。
 */
export function EnvVarPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [form] = Form.useForm<EnvFormValues>();
    // editingKey: null=未开弹窗；''=新增；非空=修改该键的值（键名锁定）
    const [editingKey, setEditingKey] = useState<string | null>(null);

    const { data, loading, refresh } = useRequest(async () => {
        const res = await listEnvApi();
        return res.code === SUCCESS_CODE ? res.data : undefined;
    });
    const keys = data?.keys ?? [];

    const openCreate = () => {
        setEditingKey('');
        form.resetFields();
    };
    const openEdit = (key: string) => {
        setEditingKey(key);
        form.setFieldsValue({ key, value: '' });
    };

    const { loading: saving, run: runSave } = useRequest(
        async (values: EnvFormValues) => {
            const res = await setEnvVarApi(values.key.trim(), values.value);
            if (res.code !== SUCCESS_CODE) throw new Error(res.message || '保存失败');
            return res.data;
        },
        {
            manual: true,
            onSuccess: () => {
                message.success('已保存，新对话即可使用');
                setEditingKey(null);
                refresh();
            },
            onError: (e) => message.error(e.message)
        }
    );

    const handleDelete = async (key: string) => {
        const res = await removeEnvVarApi(key);
        if (res.code === SUCCESS_CODE) {
            message.success('已删除');
            refresh();
        }
    };

    return (
        <Spin spinning={loading} className={cx('env-panel', styles.toString())}>
            <div className="env-panel-row">
                <div>
                    <div className="env-panel-hint">
                        供技能、脚本与 MCP 服务经 process.env 读取（如技能所需的 API Key / Token）。保存后新对话即生效；
                        若变量被已连接的 MCP 服务以 ${'${VAR}'} 方式引用，需重连该服务或重启后端才会读到新值。
                    </div>
                </div>
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                    新增变量
                </Button>
            </div>

            <div className="env-panel-list-header">已配置的变量（{keys.length}）</div>

            {keys.length === 0 ? (
                <Empty description="暂无环境变量" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
                <div className="env-panel-list">
                    {keys.map((key) => (
                        <div key={key} className="env-panel-item">
                            <div className="env-panel-item-main">
                                <code className="env-panel-item-key">{key}</code>
                                <Tag className="env-panel-item-tag" color="green">
                                    已配置
                                </Tag>
                            </div>
                            <div className="env-panel-item-meta">
                                <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(key)}>
                                    修改值
                                </Button>
                                <Popconfirm
                                    title="删除此环境变量？"
                                    description="删除后依赖它的技能可能无法使用"
                                    onConfirm={() => handleDelete(key)}
                                    okText="删除"
                                    cancelText="取消"
                                    okButtonProps={{ danger: true }}
                                >
                                    <Button type="text" size="small" danger icon={<DeleteOutlined />}>
                                        删除
                                    </Button>
                                </Popconfirm>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <Modal
                open={editingKey !== null}
                title={editingKey ? `修改 ${editingKey}` : '新增环境变量'}
                confirmLoading={saving}
                onCancel={() => setEditingKey(null)}
                onOk={() => form.submit()}
            >
                <Form form={form} layout="vertical" onFinish={runSave} requiredMark={false}>
                    <Form.Item
                        name="key"
                        label="变量名"
                        rules={[
                            { required: true, message: '请输入变量名' },
                            {
                                pattern: ENV_KEY_PATTERN,
                                message: '大写字母开头，仅支持大写字母、数字、下划线'
                            }
                        ]}
                    >
                        <Input placeholder="如 TENCENT_DOCS_TOKEN" disabled={!!editingKey} autoComplete="off" />
                    </Form.Item>
                    <Form.Item name="value" label="变量值" rules={[{ required: true, message: '请输入变量值' }]}>
                        <Input.Password placeholder="粘贴 API Key / Token" autoComplete="off" />
                    </Form.Item>
                </Form>
            </Modal>
        </Spin>
    );
}

export default EnvVarPanel;
