import { useRequest } from 'ahooks';
import { Alert, App, Button, Form, Input, Select, Space, Spin } from 'antd';
import { useEffect, useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { createProviderApi, fetchModelConfigApi, setActiveModelApi, testProviderApi } from '@/services';
import type { ProviderKind } from '@/services';

interface ModelStepProps {
    /** 向父级上报模型是否就绪（已存在激活模型或本次创建并激活成功），用于控制推进闸口 */
    onReady: (ready: boolean) => void;
}

interface ModelFormValues {
    name: string;
    kind: ProviderKind;
    baseURL: string;
    apiKey: string;
    model: string;
}

const KIND_OPTIONS = [
    { value: 'openai', label: 'OpenAI（原生）' },
    { value: 'anthropic', label: 'Anthropic（原生）' },
    { value: 'google', label: 'Google Gemini（原生）' },
    { value: 'openai-compatible', label: 'OpenAI 兼容（DeepSeek / 千帆 / 本地网关等）' }
];

/** 按接入类型预填 API 地址，减少输入；兼容类型留空由用户填网关地址 */
const BASE_URL_PRESET: Record<ProviderKind, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    google: 'https://generativelanguage.googleapis.com/v1beta',
    'openai-compatible': ''
};

/**
 * 引导第二步（必填闸口）：配置并激活一个模型 provider。
 * 挂载时探测后端已有激活模型，有则直接放行；否则需填写并保存后才放行。
 */
export function ModelStep({ onReady }: ModelStepProps) {
    const { message } = App.useApp();
    const [form] = Form.useForm<ModelFormValues>();
    // 当前激活模型引用（providerName/modelName），探测到或本次保存成功后置值
    const [activeRef, setActiveRef] = useState<string>();
    // 已保存的 provider 名，供「测试连接」使用（测试接口按 provider 名定位已存密钥）
    const [savedName, setSavedName] = useState<string>();

    const { loading: detecting } = useRequest(async () => {
        const res = await fetchModelConfigApi();
        const ref = res.code === SUCCESS_CODE ? res.data?.activeModel : undefined;
        if (ref) {
            setActiveRef(ref);
            onReady(true);
        }
    });

    useEffect(() => {
        form.setFieldsValue({ kind: 'openai', name: 'default', baseURL: BASE_URL_PRESET.openai });
    }, [form]);

    const { loading: saving, run: runSave } = useRequest(
        async (values: ModelFormValues) => {
            const createRes = await createProviderApi({
                name: values.name,
                kind: values.kind,
                baseURL: values.baseURL,
                apiKey: values.apiKey,
                models: [values.model]
            });
            if (createRes.code !== SUCCESS_CODE) return;
            const ref = `${values.name}/${values.model}`;
            const activeRes = await setActiveModelApi(ref);
            if (activeRes.code !== SUCCESS_CODE) {
                message.warning('已创建 provider，但未能设为激活模型，请重试');
                return;
            }
            setSavedName(values.name);
            setActiveRef(ref);
            onReady(true);
            message.success('模型已配置并设为激活');
        },
        { manual: true }
    );

    const { loading: testing, run: runTest } = useRequest(
        async () => {
            if (!savedName) return;
            const res = await testProviderApi(savedName);
            if (res.code !== SUCCESS_CODE) return;
            if (res.data?.ok) message.success('连接成功');
            else message.error(`连接失败：${res.data?.error || '未知错误'}`);
        },
        { manual: true }
    );

    const handleSave = async () => {
        let values: ModelFormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        runSave(values);
    };

    const handleKindChange = (kind: ProviderKind) => form.setFieldValue('baseURL', BASE_URL_PRESET[kind]);

    return (
        <Spin spinning={detecting}>
            <div className="onboarding-step onboarding-model">
                <h2 className="onboarding-step-title">配置 AI 模型</h2>
                <p className="onboarding-step-desc">
                    至少配置一个模型并设为激活，才能开始对话。更多 provider、多模态能力等可稍后在「设置 →
                    模型配置」中补充。
                </p>

                {activeRef && (
                    <Alert
                        type="success"
                        showIcon
                        className="onboarding-model-active"
                        title={`当前激活模型：${activeRef}`}
                        description="已就绪，可直接下一步；也可在下方重新配置并覆盖。"
                    />
                )}

                <Form form={form} layout="vertical" autoComplete="off">
                    <Form.Item
                        name="name"
                        label="名称"
                        extra="唯一标识，激活模型以「名称/模型名」引用"
                        rules={[
                            { required: true, message: '请输入名称' },
                            { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅支持字母、数字、下划线、连字符' }
                        ]}
                    >
                        <Input placeholder="default" />
                    </Form.Item>
                    <Form.Item name="kind" label="接入类型" rules={[{ required: true }]}>
                        <Select options={KIND_OPTIONS} onChange={handleKindChange} />
                    </Form.Item>
                    <Form.Item name="baseURL" label="API 地址" rules={[{ required: true, message: '请输入 API 地址' }]}>
                        <Input placeholder="https://api.openai.com/v1" autoComplete="url" />
                    </Form.Item>
                    <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: '请输入 API Key' }]}>
                        <Input.Password placeholder="sk-xxx" autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item name="model" label="模型名" rules={[{ required: true, message: '请输入模型名' }]}>
                        <Input placeholder="gpt-4o、claude-sonnet-5-5、gemini-2.5-pro …" />
                    </Form.Item>
                    <Space>
                        <Button type="primary" loading={saving} onClick={handleSave}>
                            保存并激活
                        </Button>
                        <Button loading={testing} disabled={!savedName} onClick={runTest}>
                            测试连接
                        </Button>
                    </Space>
                </Form>
            </div>
        </Spin>
    );
}

export default ModelStep;
