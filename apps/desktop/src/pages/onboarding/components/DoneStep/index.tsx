import { CheckCircleFilled } from '@ant-design/icons';

/** 引导最后一步：完成提示。实际「进入应用」动作由向导外壳底部按钮触发 */
export function DoneStep() {
    return (
        <div className="onboarding-step onboarding-done">
            <CheckCircleFilled className="onboarding-done-icon" />
            <h2 className="onboarding-step-title">全部就绪</h2>
            <p className="onboarding-step-desc">
                初始化配置已完成。点击「进入应用」开始你的第一段对话，所有配置都可以在「设置」中随时调整。
            </p>
        </div>
    );
}

export default DoneStep;
