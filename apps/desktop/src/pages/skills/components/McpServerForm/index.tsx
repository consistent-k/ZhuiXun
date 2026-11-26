import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Form, Input, Select, Space, Switch } from 'antd';
import { useEffect } from 'react';

import Modal from '@/components/Modal';
import type { MCPServerItem, MCPTransport } from '@/types/mcp';

import useStyles from './styles';

interface McpServerFormProps {
    open: boolean;
    editingServer?: MCPServerItem | null;
    onClose: () => void;
    onSubmit: (values: Omit<MCPServerItem, 'status' | 'error' | 'toolCount' | 'authenticated'>) => void;
}

interface FormValues {
    name: string;
    transport: MCPTransport;
    command?: string;
    args?: string[];
    url?: string;
    env?: Array<{ key: string; value: string }>;
    disabled?: boolean;
    authType?: 'none' | 'oauth';
    headers?: Array<{ key: string; value: string }>;
    oauthScope?: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
}

export function McpServerForm({ open, editingServer, onClose, onSubmit }: McpServerFormProps) {
    const { styles, cx } = useStyles();
    const [form] = Form.useForm<FormValues>();
    const transport = Form.useWatch('transport', form);
    const authType = Form.useWatch('authType', form);

    useEffect(() => {
        if (open) {
            if (editingServer) {
                const envEntries = editingServer.env
                    ? Object.entries(editingServer.env).map(([key, value]) => ({ key, value }))
                    : [];
                form.setFieldsValue({
                    name: editingServer.name,
                    transport: editingServer.transport,
                    command: editingServer.command,
                    args: editingServer.args,
                    url: editingServer.url,
                    disabled: editingServer.disabled,
                    authType: editingServer.authType || 'none',
                    headers: editingServer.headers
                        ? Object.entries(editingServer.headers).map(([key, value]) => ({ key, value }))
                        : undefined,
                    oauthScope: editingServer.oauth?.scope,
                    oauthClientId: editingServer.oauth?.clientId,
                    oauthClientSecret: editingServer.oauth?.clientSecret,
                    env: envEntries.length > 0 ? envEntries : undefined
                });
            } else {
                form.resetFields();
                form.setFieldsValue({ transport: 'stdio', authType: 'none' });
            }
        }
    }, [open, editingServer, form]);

    const handleOk = async () => {
        const values = await form.validateFields();
        const envObject: Record<string, string> | undefined = values.env?.length
            ? Object.fromEntries(values.env.filter((e) => e.key).map((e) => [e.key, e.value]))
            : undefined;

        const oauth =
            values.authType === 'oauth'
                ? {
                      scope: values.oauthScope || undefined,
                      clientId: values.oauthClientId || undefined,
                      clientSecret: values.oauthClientSecret || undefined
                  }
                : undefined;

        onSubmit({
            name: values.name,
            transport: values.transport,
            command: values.command,
            args: values.args?.filter(Boolean),
            url: values.url,
            disabled: values.disabled,
            authType: values.authType || 'none',
            oauth,
            headers: Object.fromEntries(
                (values.headers ?? []).filter((entry) => entry.key).map((entry) => [entry.key, entry.value ?? ''])
            ),
            env: envObject
        });
    };

    return (
        <Modal
            title={editingServer ? '编辑 MCP Server' : '添加 MCP Server'}
            open={open}
            onCancel={onClose}
            onOk={handleOk}
        >
            <Form
                className={cx('mcp-server-form', styles.toString())}
                form={form}
                layout="vertical"
                autoComplete="off"
                initialValues={{ transport: 'stdio', authType: 'none' }}
            >
                <div className="modal-form-grid">
                    <Form.Item
                        name="name"
                        label="服务名称"
                        rules={[
                            { required: true, message: '请输入服务名称' },
                            { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅支持字母、数字、下划线、连字符' }
                        ]}
                    >
                        <Input placeholder="my-mcp-server" disabled={!!editingServer} />
                    </Form.Item>

                    <Form.Item name="transport" label="传输方式" rules={[{ required: true }]}>
                        <Select
                            options={[
                                { value: 'stdio', label: 'stdio（子进程）' },
                                { value: 'sse', label: 'SSE（远程）' },
                                { value: 'streamableHttp', label: 'Streamable HTTP' }
                            ]}
                        />
                    </Form.Item>
                </div>

                {transport !== 'stdio' && (
                    <Form.Item label="请求头（Headers）">
                        <Form.List name="headers">
                            {(fields, { add, remove }) => (
                                <>
                                    {fields.map((field) => (
                                        <Space key={field.key} align="baseline">
                                            <Form.Item
                                                name={[field.name, 'key']}
                                                rules={[{ required: true, message: '请输入 Header 名称' }]}
                                            >
                                                <Input placeholder="Authorization" />
                                            </Form.Item>
                                            <Form.Item name={[field.name, 'value']}>
                                                <Input.Password
                                                    autoComplete="off"
                                                    placeholder={editingServer ? '留空保留已保存值' : 'Bearer …'}
                                                />
                                            </Form.Item>
                                            <Button
                                                type="text"
                                                aria-label="移除请求头"
                                                onClick={() => remove(field.name)}
                                                icon={<MinusCircleOutlined />}
                                            />
                                        </Space>
                                    ))}
                                    <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                                        添加请求头
                                    </Button>
                                </>
                            )}
                        </Form.List>
                    </Form.Item>
                )}
                {transport === 'stdio' && (
                    <>
                        <Form.Item name="command" label="命令" rules={[{ required: true, message: '请输入命令' }]}>
                            <Input placeholder="node" />
                        </Form.Item>

                        <Form.Item label="参数 (Args)">
                            <Form.List name="args">
                                {(fields, { add, remove }) => (
                                    <>
                                        {fields.map((field) => (
                                            <Space key={field.key} align="baseline" className="mcp-server-form-arg-row">
                                                <Form.Item {...field} noStyle>
                                                    <Input
                                                        className="mcp-server-form-arg-input"
                                                        placeholder="/path/to/script.js"
                                                    />
                                                </Form.Item>
                                                <MinusCircleOutlined onClick={() => remove(field.name)} />
                                            </Space>
                                        ))}
                                        <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                                            添加参数
                                        </Button>
                                    </>
                                )}
                            </Form.List>
                        </Form.Item>

                        <Form.Item label="环境变量 (Env)">
                            <Form.List name="env">
                                {(fields, { add, remove }) => (
                                    <>
                                        {fields.map((field) => (
                                            <div key={field.key} className="mcp-server-form-env-row">
                                                <Form.Item
                                                    {...field}
                                                    name={[field.name, 'key']}
                                                    noStyle
                                                    rules={[{ required: true, message: '请输入变量名' }]}
                                                >
                                                    <Input className="mcp-server-form-env-key" placeholder="变量名" />
                                                </Form.Item>
                                                <Form.Item
                                                    {...field}
                                                    name={[field.name, 'value']}
                                                    noStyle
                                                    rules={[{ required: true, message: '请输入变量值' }]}
                                                >
                                                    <Input
                                                        className="mcp-server-form-env-value"
                                                        placeholder="变量值（支持 ${VAR} 引用环境变量）"
                                                    />
                                                </Form.Item>
                                                <MinusCircleOutlined onClick={() => remove(field.name)} />
                                            </div>
                                        ))}
                                        <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                                            添加环境变量
                                        </Button>
                                    </>
                                )}
                            </Form.List>
                        </Form.Item>
                    </>
                )}

                {(transport === 'sse' || transport === 'streamableHttp') && (
                    <>
                        <Form.Item
                            name="url"
                            label={transport === 'sse' ? 'SSE URL' : 'Streamable HTTP URL'}
                            rules={[{ required: true, message: '请输入 URL' }]}
                        >
                            <Input placeholder="http://localhost:3002/mcp" />
                        </Form.Item>

                        <Form.Item name="authType" label="认证方式">
                            <Select
                                options={[
                                    { value: 'none', label: '无认证' },
                                    { value: 'oauth', label: 'OAuth 2.0' }
                                ]}
                            />
                        </Form.Item>

                        {authType === 'oauth' && (
                            <div className="mcp-server-form-oauth-section">
                                <Form.Item name="oauthScope" label="Scope（可选）">
                                    <Input placeholder="read:user repo" />
                                </Form.Item>
                                <Form.Item name="oauthClientId" label="Client ID（可选，留空使用动态注册）">
                                    <Input placeholder="留空则自动注册" />
                                </Form.Item>
                                <Form.Item name="oauthClientSecret" label="Client Secret（可选）">
                                    <Input.Password placeholder="配合 Client ID 使用" />
                                </Form.Item>
                            </div>
                        )}
                    </>
                )}

                <Form.Item name="disabled" label="禁用" valuePropName="checked">
                    <Switch checkedChildren="禁用" unCheckedChildren="启用" />
                </Form.Item>
            </Form>
        </Modal>
    );
}
