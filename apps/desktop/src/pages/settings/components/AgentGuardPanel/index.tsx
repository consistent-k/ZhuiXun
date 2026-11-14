import { SaveOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, InputNumber, Space, Spin, Switch } from 'antd';
import { useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchAppSettingsApi, updateAppSettingsApi, type AppSettingsView } from '@/services';

import useStyles from './styles';

type GuardForm = Pick<AppSettingsView, 'maxAgentSteps' | 'repeatErrorLimit' | 'modelMaxRetries'>;

const DEFAULT_FORM: GuardForm = { maxAgentSteps: 40, repeatErrorLimit: 3, modelMaxRetries: 3 };

/** 设置页「运行护栏」：单轮步数上限、重复失败熔断阈值、模型重试次数与 prompt 缓存开关。 */
export function AgentGuardPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [form, setForm] = useState<GuardForm>(DEFAULT_FORM);
    const [caching, setCaching] = useState(true);
    const [saving, setSaving] = useState(false);

    const { loading } = useRequest(
        async () => {
            const res = await fetchAppSettingsApi();
            return res.code === SUCCESS_CODE ? res.data : undefined;
        },
        {
            onSuccess: (data) => {
                if (!data) return;
                setForm({
                    maxAgentSteps: data.maxAgentSteps,
                    repeatErrorLimit: data.repeatErrorLimit,
                    modelMaxRetries: data.modelMaxRetries
                });
                setCaching(data.promptCaching);
            }
        }
    );

    const update = (key: keyof GuardForm) => (value: number | null) => {
        if (value !== null) setForm((prev) => ({ ...prev, [key]: value }));
    };

    const handleToggleCaching = async (checked: boolean) => {
        setCaching(checked);
        const res = await updateAppSettingsApi({ promptCaching: checked });
        if (res.code === SUCCESS_CODE) message.success(checked ? '已开启 Prompt 缓存' : '已关闭 Prompt 缓存');
        else setCaching(!checked);
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await updateAppSettingsApi(form);
            if (res.code === SUCCESS_CODE) message.success('运行护栏已保存');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Spin spinning={loading} className={cx('agent-guard-panel', styles.toString())}>
            <div className="agent-guard-panel-field">
                <div className="agent-guard-panel-title">单轮步数上限</div>
                <div className="agent-guard-panel-hint">
                    一轮回答中模型最多连续调用工具的步数。达到上限会暂停并在消息下方提供「继续」；数值越大越能完成长任务，单轮消耗也越多。
                </div>
                <Space.Compact className="agent-guard-panel-control">
                    <InputNumber
                        className="agent-guard-panel-input"
                        aria-label="单轮步数上限"
                        min={10}
                        max={200}
                        precision={0}
                        value={form.maxAgentSteps}
                        onChange={update('maxAgentSteps')}
                    />
                    <Space.Addon>步</Space.Addon>
                </Space.Compact>
            </div>

            <div className="agent-guard-panel-field">
                <div className="agent-guard-panel-title">重复失败熔断</div>
                <div className="agent-guard-panel-hint">
                    同一工具连续以相同错误失败、或以相同参数反复调用达到该次数时暂停；达到前一次会先提示模型换一种方法。
                </div>
                <Space.Compact className="agent-guard-panel-control">
                    <InputNumber
                        className="agent-guard-panel-input"
                        aria-label="重复失败熔断"
                        min={2}
                        max={10}
                        precision={0}
                        value={form.repeatErrorLimit}
                        onChange={update('repeatErrorLimit')}
                    />
                    <Space.Addon>次</Space.Addon>
                </Space.Compact>
            </div>

            <div className="agent-guard-panel-field">
                <div className="agent-guard-panel-title">模型请求重试</div>
                <div className="agent-guard-panel-hint">
                    模型服务限流、过载或网络中断时的自动重试次数（指数退避）。已开始输出回答后不会自动重试，可在消息下方手动「重试」。
                </div>
                <Space.Compact className="agent-guard-panel-control">
                    <InputNumber
                        className="agent-guard-panel-input"
                        aria-label="模型请求重试"
                        min={0}
                        max={5}
                        precision={0}
                        value={form.modelMaxRetries}
                        onChange={update('modelMaxRetries')}
                    />
                    <Space.Addon>次</Space.Addon>
                </Space.Compact>
            </div>

            <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                onClick={handleSave}
                className="agent-guard-panel-save"
            >
                保存
            </Button>

            <div className="agent-guard-panel-row">
                <div>
                    <div className="agent-guard-panel-title">Prompt 缓存</div>
                    <div className="agent-guard-panel-hint">
                        为 Anthropic 模型复用系统提示与历史前缀的缓存，降低长对话的延迟与费用。OpenAI
                        及兼容网关由服务端自动缓存，不受此开关影响。
                    </div>
                </div>
                <Switch checked={caching} onChange={handleToggleCaching} />
            </div>
        </Spin>
    );
}

export default AgentGuardPanel;
