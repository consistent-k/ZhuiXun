import { Form, Input, InputNumber, Select } from 'antd';
import { useEffect } from 'react';

import Modal from '@/components/Modal';
import type { ProviderConfig, ProviderKind, ProviderView } from '@/services';

interface ProviderFormProps {
    open: boolean;
    /** 编辑时传入现有 provider（脱敏视图）；新增时为 null */
    editingProvider?: ProviderView | null;
    onClose: () => void;
    onSubmit: (values: ProviderConfig) => void;
}

interface FormValues {
    name: string;
    kind: ProviderKind;
    baseURL: string;
    apiKey?: string;
    models: string[];
    /** 每模型上下文窗口（选填），key=模型名；空 InputNumber 取 null，提交时归一为不写入 */
    modelMeta?: Record<string, { contextWindow?: number | null }>;
}

const KIND_OPTIONS = [
    { value: 'openai', label: 'OpenAI（原生）' },
    { value: 'anthropic', label: 'Anthropic（原生）' },
    { value: 'google', label: 'Google Gemini（原生）' },
    { value: 'openai-compatible', label: 'OpenAI 兼容（DeepSeek / 千帆 / 本地网关等）' }
];

/** 按接入类型给出 API 地址输入提示，减少用户查文档；实际值仍由用户填写 */
const BASE_URL_PLACEHOLDER: Record<ProviderKind, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    google: 'https://generativelanguage.googleapis.com/v1beta',
    'openai-compatible': 'https://your-gateway.example.com/v1'
};

/** 去掉首尾空白（粘贴「a, b」时逗号后的空格会留在下一项开头）、丢弃空项并去重，保留模型名内部空格 */
function normalizeModels(value?: string[]): string[] {
    const seen = new Set<string>();
    for (const raw of value ?? []) {
        const m = raw.trim();
        if (m) seen.add(m);
    }
    return [...seen];
}

export function ProviderForm({ open, editingProvider, onClose, onSubmit }: ProviderFormProps) {
    const [form] = Form.useForm<FormValues>();
    const isEdit = !!editingProvider;
    const configured = !!editingProvider?.configured;
    // 当前录入的模型列表：用于按模型名动态渲染 contextWindow 输入项
    const models = Form.useWatch('models', form) ?? [];
    const kind = Form.useWatch('kind', form) ?? 'openai';

    useEffect(() => {
        if (!open) return;
        if (editingProvider) {
            form.setFieldsValue({
                name: editingProvider.name,
                kind: editingProvider.kind,
                baseURL: editingProvider.baseURL,
                apiKey: '',
                models: editingProvider.models,
                modelMeta: editingProvider.modelMeta ?? {}
            });
        } else {
            form.resetFields();
            form.setFieldsValue({
                kind: 'openai',
                models: [],
                modelMeta: {}
            });
        }
    }, [open, editingProvider, form]);

    const handleOk = async () => {
        const values = await form.validateFields();
        const selectedModels = values.models ?? [];
        // 仅保留仍在 models 列表内、且填了正整数上限的条目；空 InputNumber(null) 归一为不写入
        const rawMeta = values.modelMeta ?? {};
        const modelMeta: Record<string, { contextWindow: number }> = {};
        for (const m of selectedModels) {
            const cw = rawMeta[m]?.contextWindow;
            if (typeof cw === 'number' && cw > 0) modelMeta[m] = { contextWindow: cw };
        }
        onSubmit({
            name: values.name,
            kind: values.kind,
            baseURL: values.baseURL,
            // 留空表示保留后端已存密钥
            apiKey: values.apiKey ? values.apiKey : undefined,
            models: selectedModels,
            modelMeta: Object.keys(modelMeta).length > 0 ? modelMeta : undefined
        });
    };

    return (
        <Modal title={isEdit ? '编辑模型提供方' : '添加模型提供方'} open={open} onCancel={onClose} onOk={handleOk}>
            <Form form={form} layout="vertical" autoComplete="off" initialValues={{ kind: 'openai', models: [] }}>
                <div className="modal-form-grid">
                    <Form.Item
                        name="name"
                        label="名称"
                        extra="唯一标识，激活模型以「名称/模型名」引用它"
                        rules={[
                            { required: true, message: '请输入名称' },
                            { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅支持字母、数字、下划线、连字符' }
                        ]}
                    >
                        <Input placeholder="openai-main" disabled={isEdit} />
                    </Form.Item>
                    <Form.Item name="kind" label="接入类型" rules={[{ required: true }]}>
                        <Select options={KIND_OPTIONS} />
                    </Form.Item>
                </div>

                <Form.Item name="baseURL" label="API 地址" rules={[{ required: true, message: '请输入 API 地址' }]}>
                    <Input placeholder={BASE_URL_PLACEHOLDER[kind]} autoComplete="url" />
                </Form.Item>
                <Form.Item
                    name="apiKey"
                    label="API Key"
                    rules={configured ? [] : [{ required: true, message: '请输入 API Key' }]}
                    extra={configured ? '已配置密钥；留空表示保留原值，如需更换请重新输入' : undefined}
                >
                    <Input.Password
                        placeholder={configured ? '已配置（留空保留原值）' : 'sk-xxx'}
                        autoComplete="new-password"
                    />
                </Form.Item>
                <section className="modal-form-section">
                    <h3>模型配置</h3>
                    <Form.Item
                        name="models"
                        label="模型列表"
                        extra="输入模型名后回车添加，可用逗号分隔批量添加"
                        normalize={normalizeModels}
                    >
                        {/* 空格不能作分隔符：部分模型名本身含空格（如「Opus 5.5」），会被错误拆成两个模型 */}
                        <Select
                            mode="tags"
                            placeholder="gpt-4o、claude-sonnet-5-5、gemini-2.5-pro …"
                            tokenSeparators={[',', '，']}
                            open={false}
                        />
                    </Form.Item>
                    {models.length > 0 && (
                        <Form.Item
                            label="上下文窗口"
                            extra="选填。填写后对话页可展示「剩余上下文」；不填则仅展示已用 token"
                        >
                            {models.map((m) => (
                                <Form.Item
                                    key={m}
                                    name={['modelMeta', m, 'contextWindow']}
                                    label={m}
                                    style={{ marginBottom: 8 }}
                                >
                                    <InputNumber
                                        min={1}
                                        precision={0}
                                        style={{ width: '100%' }}
                                        placeholder="上下文窗口 token 上限（选填），如 200000"
                                    />
                                </Form.Item>
                            ))}
                        </Form.Item>
                    )}
                </section>
            </Form>
        </Modal>
    );
}

export default ProviderForm;
