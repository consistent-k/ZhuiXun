/** 引导第一步：品牌与应用简介，引导用户开始最小必要配置 */
export function WelcomeStep() {
    return (
        <div className="onboarding-step onboarding-welcome">
            <h2 className="onboarding-step-title">欢迎使用 追寻</h2>
            <p className="onboarding-step-desc">
                在开始对话前，仅需完成几项必要配置。整个过程不超过一分钟，之后都可以在「设置」中随时调整。
            </p>
            <ul className="onboarding-welcome-list">
                <li>配置一个 AI 模型（必填，用于驱动对话）</li>
                <li>选择默认对话模式</li>
                <li>挑选一个喜欢的界面主题</li>
            </ul>
        </div>
    );
}

export default WelcomeStep;
