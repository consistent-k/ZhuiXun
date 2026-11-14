import { useRequest } from 'ahooks';
import { App, Radio } from 'antd';
import { useEffect } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { ThemeSwitcher } from '@/pages/settings/components/ThemeSwitcher';
import { updateAppSettingsApi, type AgentMode } from '@/services';
import { useAppConfigStore } from '@/stores';

const AGENT_MODE_OPTIONS = [
    { value: 'routed', label: 'Routed（默认，加载全部工具）' },
    { value: 'progressive', label: 'Progressive（按需加载工具，省上下文）' }
];

/**
 * 引导第三步（选填）：默认对话模式 + 界面主题。两项均有默认值，可直接下一步。
 * 对话模式真源在后端 app 段，主题为纯前端持久化（经复用的 ThemeSwitcher 即时生效）。
 */
export function PreferenceStep() {
    const { message } = App.useApp();
    const defaultAgentMode = useAppConfigStore((s) => s.defaultAgentMode);
    const setDefaultAgentMode = useAppConfigStore((s) => s.setDefaultAgentMode);

    // 拉取后端应用级偏好，保证对话模式初值与真源一致（store 内部去重，重复调用安全）
    useEffect(() => {
        void useAppConfigStore.getState().hydrate();
    }, []);

    const { loading, run: handleChangeMode } = useRequest(
        async (mode: AgentMode) => {
            const res = await updateAppSettingsApi({ defaultAgentMode: mode });
            if (res.code === SUCCESS_CODE && res.data) {
                setDefaultAgentMode(res.data.defaultAgentMode);
                message.success('已更新默认对话模式');
            }
        },
        { manual: true }
    );

    return (
        <div className="onboarding-step onboarding-preference">
            <h2 className="onboarding-step-title">偏好设置</h2>
            <p className="onboarding-step-desc">以下均为可选项，保留默认也能正常使用，之后可在「设置」中随时更改。</p>

            <div className="onboarding-preference-block">
                <div className="onboarding-preference-label">默认对话模式</div>
                <Radio.Group
                    value={defaultAgentMode}
                    disabled={loading}
                    onChange={(e) => handleChangeMode(e.target.value as AgentMode)}
                    options={AGENT_MODE_OPTIONS}
                />
            </div>

            <div className="onboarding-preference-block">
                <div className="onboarding-preference-label">界面主题</div>
                <ThemeSwitcher />
            </div>
        </div>
    );
}

export default PreferenceStep;
