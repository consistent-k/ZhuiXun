import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Form, Input, Select } from 'antd';
import { useEffect, useState } from 'react';

import Modal from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import {
    createSkillApi,
    fetchMCPServersApi,
    fetchMCPServerToolsApi,
    fetchSkillDetailApi,
    updateSkillApi
} from '@/services';
import type { SkillUpsertBody } from '@/types/skill';

import useStyles from './styles';

interface FormValues {
    name: string;
    displayName?: string;
    description: string;
    triggers?: string[];
    allowedTools?: string[];
    systemPrompt: string;
}

interface SkillFormProps {
    open: boolean;
    /** 传 id 为编辑，null 为新增 */
    editingSkillId: string | null;
    onClose: () => void;
    /** 提交成功后回调（父组件据此 refetch 列表） */
    onSubmitted: () => void;
}

export function SkillForm({ open, editingSkillId, onClose, onSubmitted }: SkillFormProps) {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [form] = Form.useForm<FormValues>();
    const [submitting, setSubmitting] = useState(false);
    const isEdit = !!editingSkillId;

    // 加载「可绑定工具」候选：内置 shell + 已连接 MCP 工具（allowed-tools 用 Claude Code 风格标识符）
    const { data: toolOptions = [] } = useRequest(
        async () => {
            const shell = ['Bash', 'Read', 'Write'].map((t) => ({ label: `内置 · ${t}`, value: t }));
            const options = [...shell];
            const res = await fetchMCPServersApi();
            const connected = (res.code === SUCCESS_CODE ? (res.data ?? []) : []).filter(
                (s) => s.status === 'connected'
            );
            const toolLists = await Promise.all(
                connected.map((s) =>
                    fetchMCPServerToolsApi(s.name).then((r) => (r.code === SUCCESS_CODE ? (r.data ?? []) : []))
                )
            );
            connected.forEach((s, i) => {
                for (const tool of toolLists[i]) {
                    options.push({
                        label: `MCP · ${s.name} / ${tool.name}`,
                        value: `mcp__${s.name}__${tool.name}`
                    });
                }
            });
            return options;
        },
        { ready: open, refreshDeps: [open] }
    );

    // 新建模式：打开时重置表单（编辑模式由下面拉详情回填）
    useEffect(() => {
        if (open && !editingSkillId) form.resetFields();
    }, [open, editingSkillId, form]);

    // 编辑：列表项不含 systemPrompt，需拉详情回填；detailLoading 用于禁用表单
    const { loading: detailLoading } = useRequest(
        async () => {
            if (!editingSkillId) return null;
            const res = await fetchSkillDetailApi(editingSkillId);
            return res.code === SUCCESS_CODE ? res.data : null;
        },
        {
            ready: open && !!editingSkillId,
            refreshDeps: [open, editingSkillId],
            onSuccess: (detail) => {
                if (!detail) return;
                form.setFieldsValue({
                    name: detail.id,
                    displayName: detail.displayName,
                    description: detail.description,
                    triggers: detail.triggers,
                    allowedTools: detail.allowedTools,
                    systemPrompt: detail.systemPrompt
                });
            }
        }
    );

    const handleOk = async () => {
        const values = await form.validateFields();
        const body: SkillUpsertBody = {
            name: values.name,
            displayName: values.displayName?.trim() || undefined,
            description: values.description.trim(),
            triggers: values.triggers?.map((t) => t?.trim()).filter(Boolean) as string[] | undefined,
            allowedTools: values.allowedTools?.length ? values.allowedTools : undefined,
            systemPrompt: values.systemPrompt
        };

        setSubmitting(true);
        try {
            const res = editingSkillId ? await updateSkillApi(editingSkillId, body) : await createSkillApi(body);
            if (res.code === SUCCESS_CODE) {
                message.success(editingSkillId ? '技能已更新' : '技能已创建');
                onSubmitted();
                onClose();
            }
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            title={isEdit ? '编辑技能' : '新增技能'}
            open={open}
            onCancel={onClose}
            onOk={handleOk}
            confirmLoading={submitting}
        >
            <Form
                className={cx('skill-form', styles.toString())}
                form={form}
                layout="vertical"
                autoComplete="off"
                disabled={detailLoading}
            >
                <div className="modal-form-grid">
                    <Form.Item
                        name="name"
                        label="技能 ID"
                        tooltip="小写字母、数字、连字符，作为技能唯一标识与目录名，创建后不可修改"
                        rules={[
                            { required: true, message: '请输入技能 ID' },
                            {
                                pattern: /^[a-z][a-z0-9-]*$/,
                                message: '仅支持小写字母、数字、连字符，且以字母开头'
                            }
                        ]}
                    >
                        <Input placeholder="my-skill" disabled={isEdit} />
                    </Form.Item>

                    <Form.Item name="displayName" label="展示名称">
                        <Input placeholder="我的技能A" />
                    </Form.Item>
                </div>

                <Form.Item
                    name="description"
                    label="描述"
                    tooltip="用于模型判断何时触发该技能，尽量写清适用场景"
                    rules={[{ required: true, message: '请输入描述' }]}
                >
                    <Input.TextArea rows={2} placeholder="帮助用户……。当用户提到「……」时使用。" />
                </Form.Item>

                <Form.Item label="触发词">
                    <Form.List name="triggers">
                        {(fields, { add, remove }) => (
                            <>
                                {fields.map((field) => (
                                    <div key={field.key} className="skill-form-trigger-row">
                                        <Form.Item {...field} noStyle>
                                            <Input className="skill-form-trigger-input" placeholder="写周报" />
                                        </Form.Item>
                                        <MinusCircleOutlined onClick={() => remove(field.name)} />
                                    </div>
                                ))}
                                <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                                    添加触发词
                                </Button>
                            </>
                        )}
                    </Form.List>
                </Form.Item>

                <Form.Item
                    name="allowedTools"
                    label="可用工具（allowed-tools）"
                    tooltip="声明该技能可调用的已有工具（内置 shell / 已注册 MCP）。可从下拉选择或直接输入 Claude Code 风格规则，如 Bash(git status:*)、mcp__server__tool。不上传代码。"
                >
                    <Select
                        mode="tags"
                        allowClear
                        placeholder="选择或输入工具规则"
                        options={toolOptions}
                        tokenSeparators={[',']}
                    />
                </Form.Item>

                <Form.Item
                    name="systemPrompt"
                    label="技能指令（System Prompt）"
                    tooltip="技能被加载时作为模型的系统提示词"
                    rules={[{ required: true, message: '请输入技能指令' }]}
                >
                    <Input.TextArea rows={10} placeholder="你是一个专业的……助手，你的职责是……" />
                </Form.Item>
            </Form>
        </Modal>
    );
}
