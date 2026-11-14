import { App, Alert, Form, Input } from 'antd';
import { useEffect, useState } from 'react';

import Modal from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { createPersonaApi, updatePersonaApi, type PersonaConfigView, type PersonaView } from '@/services';

interface PersonaEditorModalProps {
    open: boolean;
    /** create=新建；edit=编辑自定义；copy=从任意风格复制一份新自定义。 */
    mode: 'create' | 'edit' | 'copy';
    /** null 仅用于 create。 */
    editing: PersonaView | null;
    onCancel: () => void;
    onSaved: (config: PersonaConfigView) => void;
}

interface PersonaFormValues {
    name: string;
    description?: string;
    instruction: string;
}

export function PersonaEditorModal({ open, mode, editing, onCancel, onSaved }: PersonaEditorModalProps) {
    const { message } = App.useApp();
    const [form] = Form.useForm<PersonaFormValues>();
    const [saving, setSaving] = useState(false);

    const isEdit = mode === 'edit';
    const isCopy = mode === 'copy';

    useEffect(() => {
        if (!open) return;
        if (!editing) {
            form.resetFields();
            return;
        }
        form.setFieldsValue({
            name: isCopy ? `${editing.name} 副本` : editing.name,
            description: editing.description,
            instruction: editing.instruction
        });
    }, [open, editing, form, isCopy]);

    const handleOk = async () => {
        let values: PersonaFormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        setSaving(true);
        try {
            const payload = {
                name: values.name,
                description: values.description ?? '',
                instruction: values.instruction
            };
            // isEdit 是独立布尔，TS 无法据此收窄 editing；edit 模式按约定必有 editing，这里显式判空收窄类型
            const res =
                isEdit && editing ? await updatePersonaApi(editing.id, payload) : await createPersonaApi(payload);
            if (res.code === SUCCESS_CODE && res.data) {
                message.success(isEdit ? '风格已更新' : '风格已创建');
                onSaved(res.data);
                onCancel();
            }
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            open={open}
            title={isEdit ? '编辑风格' : isCopy ? '复制为自定义风格' : '新建风格'}
            okText="保存"
            cancelText="取消"
            confirmLoading={saving}
            width={640}
            destroyOnHidden
            onOk={handleOk}
            onCancel={onCancel}
        >
            <Alert
                type="info"
                showIcon
                className="persona-editor-tip"
                title="风格只影响表达方式"
                description="不会改变事实判断、工具权限或记忆事实。它会随系统提示词发送给模型服务，请勿填写敏感个人信息、密钥或内部地址。"
            />
            <Form form={form} layout="vertical" requiredMark="optional">
                <Form.Item
                    label="名称"
                    name="name"
                    rules={[
                        { required: true, whitespace: true, message: '请输入风格名称' },
                        { max: 30, message: '名称不能超过 30 个字符' }
                    ]}
                >
                    <Input placeholder="例如：简洁快答" maxLength={30} showCount />
                </Form.Item>
                <Form.Item label="简介" name="description" rules={[{ max: 100, message: '简介不能超过 100 个字符' }]}>
                    <Input placeholder="一句话说明适用场景（仅用于展示）" maxLength={100} showCount />
                </Form.Item>
                <Form.Item
                    label="风格指令"
                    name="instruction"
                    rules={[
                        { required: true, whitespace: true, message: '请输入风格指令' },
                        { max: 2000, message: '风格指令不能超过 2000 个字符' }
                    ]}
                    extra="只描述语气、结构、详略和术语解释方式；不要要求忽略安全规则或改变工具权限。"
                >
                    <Input.TextArea
                        rows={8}
                        maxLength={2000}
                        showCount
                        placeholder="例如：默认不超过三个要点；先给处理建议，再补一句关键依据；不展开教科书式背景。"
                    />
                </Form.Item>
            </Form>
        </Modal>
    );
}
