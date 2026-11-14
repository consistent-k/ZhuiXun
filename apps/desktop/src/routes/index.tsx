import { createHashRouter, redirect } from 'react-router';

import { BasicLayout } from '@/layouts';
import AutomationsPage from '@/pages/automations';
import HomePage from '@/pages/home';
import OnboardingPage from '@/pages/onboarding';
import ProjectSettingsPage from '@/pages/projects';
import SettingsPage from '@/pages/settings';
import SkillMarketPage from '@/pages/skill-market';
import SkillMarketDetailPage from '@/pages/skill-market/detail';
import SkillsPage from '@/pages/skills';
import { useSettingsStore } from '@/stores';

// 用 hash 路由（/#/chat/<uuid>）：Electron 生产壳(app:// 协议)内硬刷新 / 冷启动直达深链无需资源侧
// 回退 index.html 即可用，规避 BrowserRouter 在打包后深链 404 白屏的问题。
const router = createHashRouter([
    // 初始化引导页：顶层独立路由（不挂 BasicLayout，无侧边栏），全屏向导
    { path: '/onboarding', element: <OnboardingPage /> },
    {
        // 主布局承载会话侧边栏；所有业务页都作为其子路由在内容区渲染，让侧边栏在全站常驻
        element: <BasicLayout />,
        children: [
            // 根路径不承载会话：首次使用（onboarded=false）先导向引导页，否则生成新会话 id 并重定向到
            // /chat/<uuid>。onboarded 标记由 settingsStore 经 localStorage 同步 rehydrate，loader 读取为
            // 纯本地判定、无网络、无首屏闪烁。让 Chat 实例从一开始就绑定真实会话 id，避免首轮流式期间 id
            // 变化重建实例丢流；会话仍懒到首条消息才落库，故未发消息的 uuid 只是废弃草稿，不产生残留。
            {
                path: '/',
                loader: () => {
                    if (!useSettingsStore.getState().onboarded) return redirect('/onboarding');
                    return redirect(`/chat/${crypto.randomUUID()}`);
                }
            },
            // 会话身份走 URL：/chat/<uuid> 复用同一个 HomePage，由页面内 useParams 同步到 store
            { path: '/chat/:conversationId', element: <HomePage /> },
            // 项目设置页：在主布局内渲染，保留侧栏，便于来回切换
            { path: '/project/:projectId', element: <ProjectSettingsPage /> },
            // 技能 + 连接器（MCP）：顶部 tab 切换，常驻侧栏
            { path: '/skills', element: <SkillsPage /> },
            // 技能广场（从技能 tab 进入）
            { path: '/skill-market', element: <SkillMarketPage /> },
            { path: '/skill-market/skills/:slug', element: <SkillMarketDetailPage /> },
            // 自动化任务：定时/周期无人值守任务管理，常驻侧栏
            { path: '/automations', element: <AutomationsPage /> },
            // 设置
            { path: '/settings', element: <SettingsPage /> }
        ]
    }
]);

export default router;
