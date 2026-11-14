import { Button, Steps } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useSettingsStore } from '@/stores';

import { DoneStep } from './components/DoneStep';
import { ModelStep } from './components/ModelStep';
import { PreferenceStep } from './components/PreferenceStep';
import { WelcomeStep } from './components/WelcomeStep';
import useStyles from './styles';

const STEP_ITEMS = [{ title: '欢迎' }, { title: '模型配置' }, { title: '偏好设置' }, { title: '完成' }];

/** 模型配置步骤在向导中的序号，用于「未配好模型不可离开该步」的闸口判定 */
const MODEL_STEP = 1;
const LAST_STEP = STEP_ITEMS.length - 1;

/**
 * 初始化启动引导页：全屏 4 步向导（欢迎 → 模型配置 → 偏好 → 完成）。
 * 首次使用或「恢复初始化配置」时进入；模型配置为必填闸口，未配好不可推进。
 */
export function OnboardingPage() {
    const { styles, cx } = useStyles();
    const navigate = useNavigate();
    const completeOnboarding = useSettingsStore((s) => s.completeOnboarding);

    const [current, setCurrent] = useState(0);
    // 模型步骤是否已就绪（已存在激活模型或本次创建并激活成功），作为离开模型步骤的闸口
    const [modelReady, setModelReady] = useState(false);

    // 推进被模型闸口拦截：停留在模型步骤且尚未就绪时，下一步 / 完成不可点
    const nextBlocked = current === MODEL_STEP && !modelReady;

    const handleFinish = () => {
        completeOnboarding();
        navigate(`/chat/${crypto.randomUUID()}`);
    };

    const handleNext = () => {
        if (nextBlocked) return;
        if (current === LAST_STEP) {
            handleFinish();
            return;
        }
        setCurrent((c) => c + 1);
    };

    return (
        <div className={cx('onboarding-page', styles.toString())}>
            <div className="onboarding-page-card">
                <div className="onboarding-page-brand">
                    <span className="onboarding-page-logo">追寻</span>
                    <span className="onboarding-page-brand-sub">通用桌面 AI 智能体</span>
                </div>

                <Steps className="onboarding-page-steps" current={current} items={STEP_ITEMS} size="small" />

                <div className="onboarding-page-body">
                    {current === 0 && <WelcomeStep />}
                    {current === 1 && <ModelStep onReady={setModelReady} />}
                    {current === 2 && <PreferenceStep />}
                    {current === 3 && <DoneStep />}
                </div>

                <div className="onboarding-page-footer">
                    <Button disabled={current === 0} onClick={() => setCurrent((c) => Math.max(0, c - 1))}>
                        上一步
                    </Button>
                    <Button type="primary" disabled={nextBlocked} onClick={handleNext}>
                        {current === LAST_STEP ? '进入应用' : '下一步'}
                    </Button>
                </div>
            </div>
        </div>
    );
}

export default OnboardingPage;
