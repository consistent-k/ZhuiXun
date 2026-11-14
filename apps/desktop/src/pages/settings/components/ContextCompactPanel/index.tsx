import { SaveOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Slider, Spin, Switch } from 'antd';
import { useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchAppSettingsApi, updateAppSettingsApi } from '@/services';

import useStyles from './styles';

const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 95;

export function ContextCompactPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [saving, setSaving] = useState(false);
    const [enabled, setEnabled] = useState(true);
    const [threshold, setThreshold] = useState(80);

    // 挂载即拉取应用级偏好，加载态交给 useRequest；拉到后 seed 本地可编辑状态
    const { loading } = useRequest(
        async () => {
            const res = await fetchAppSettingsApi();
            return res.code === SUCCESS_CODE ? res.data : undefined;
        },
        {
            onSuccess: (data) => {
                if (data) {
                    setEnabled(data.autoCompactEnabled);
                    setThreshold(data.autoCompactThreshold);
                }
            }
        }
    );

    const handleToggle = async (checked: boolean) => {
        setEnabled(checked);
        const res = await updateAppSettingsApi({ autoCompactEnabled: checked });
        if (res.code === SUCCESS_CODE) {
            message.success(checked ? '已开启自动压缩' : '已关闭自动压缩');
        } else {
            // 失败回滚开关（错误提示已由 request 拦截器统一弹出）
            setEnabled(!checked);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await updateAppSettingsApi({ autoCompactThreshold: threshold });
            if (res.code === SUCCESS_CODE) message.success('压缩阈值已保存');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Spin spinning={loading} className={cx('context-compact-panel', styles.toString())}>
            <div className="context-compact-panel-row">
                <div>
                    <div className="context-compact-panel-title">自动压缩上下文</div>
                    <div className="context-compact-panel-hint">
                        开启后，当对话累计用量接近模型上下文窗口上限时，自动把较早的消息摘要压缩，让长对话不超限地延续。
                        完整历史仍保留在会话记录与界面中。
                    </div>
                </div>
                <Switch checked={enabled} onChange={handleToggle} />
            </div>

            <div className="context-compact-panel-field">
                <div className="context-compact-panel-field-label">
                    <span>触发阈值</span>
                    <span className="context-compact-panel-value">{threshold}%</span>
                </div>
                <div className="context-compact-panel-hint">
                    达到「上下文窗口扣除模型输出预留后的可用窗口」的该百分比时触发压缩；数值越小越早压缩、保留的原文越少。
                    模型未配置上下文窗口时按默认 200000 tokens 估算；建议在「模型配置」填写上下文窗口以更精确。
                </div>
                <Slider
                    className="context-compact-panel-slider"
                    min={THRESHOLD_MIN}
                    max={THRESHOLD_MAX}
                    step={1}
                    value={threshold}
                    disabled={!enabled}
                    onChange={setThreshold}
                    tooltip={{ formatter: (v) => `${v}%` }}
                />
            </div>

            <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!enabled}
                onClick={handleSave}
                className="context-compact-panel-save"
            >
                保存阈值
            </Button>
        </Spin>
    );
}

export default ContextCompactPanel;
