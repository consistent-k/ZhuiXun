import { App, Form, Input } from 'antd';
import { useEffect, useState } from 'react';

import Modal from '@/components/Modal';
import { useProjectStore } from '@/stores';

interface FormValues {
    name: string;
}

interface ProjectCreateModalProps {
    open: boolean;
    onClose: () => void;
    /** 创建成功后回调，携带新项目 id（父组件据此跳转） */
    onCreated: (projectId: string) => void;
}

/** 新建项目弹窗：统一为声明式 <Modal> + <Form> 写法 */
export function ProjectCreateModal({ open, onClose, onCreated }: ProjectCreateModalProps) {
    const { message } = App.useApp();
    const [form] = Form.useForm<FormValues>();
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (open) form.resetFields();
    }, [open, form]);

    const handleOk = async () => {
        const { name } = await form.validateFields();
        setSubmitting(true);
        try {
            const id = await useProjectStore.getState().createProject({ name: name.trim() });
            if (id) {
                message.success('项目已创建');
                onCreated(id);
                onClose();
            }
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            title="新建项目"
            open={open}
            onCancel={onClose}
            onOk={handleOk}
            okText="创建"
            confirmLoading={submitting}
        >
            <Form form={form} layout="vertical" autoComplete="off">
                <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
                    <Input autoFocus placeholder="项目名称，如「产品发布」" />
                </Form.Item>
            </Form>
        </Modal>
    );
}
