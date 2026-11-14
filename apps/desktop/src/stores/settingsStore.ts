import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_THEME_ID, getTheme, type ThemeId } from '@/theme/themes';

interface SettingsState {
    theme: ThemeId;
    /** 是否已完成初始化引导。为假时根路由 loader 会把用户导向 /onboarding */
    onboarded: boolean;
}

interface SettingsActions {
    updateTheme: (theme: ThemeId) => void;
    /** 标记引导完成（走到引导最后一步时调用） */
    completeOnboarding: () => void;
    /** 清除引导完成标记，用于「恢复初始化配置」重新进入引导 */
    resetOnboarding: () => void;
}

/**
 * 前端设置 store。
 *
 * 注意：模型配置的真源在**后端 settings.json**（经 /api/settings/model 读写），前端不再持有 /
 * 持久化 modelConfig 或 apiKey——避免明文密钥进 localStorage，也与「记忆 / 会话 / 权限真源在后端」一致。
 * 本 store 只保留纯前端 UI 偏好（主题）与引导完成标记（onboarded）。
 */
export const useSettingsStore = create<SettingsState & SettingsActions>()(
    persist(
        (set) => ({
            theme: DEFAULT_THEME_ID,
            onboarded: false,
            updateTheme: (theme) => set({ theme }),
            completeOnboarding: () => set({ onboarded: true }),
            resetOnboarding: () => set({ onboarded: false })
        }),
        {
            name: 'zhuixun-settings',
            // 读取时再经 getTheme 兜底，防止持久了已下线的主题 id
            onRehydrateStorage: () => (state) => {
                if (state) state.theme = getTheme(state.theme).id;
            },
            partialize: (state) => ({ theme: state.theme, onboarded: state.onboarded })
        }
    )
);
