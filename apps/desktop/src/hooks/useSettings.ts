import { useCallback } from 'react';

import { useSettingsStore } from '@/stores';
import { themeList, type ThemeId } from '@/theme/themes';

/**
 * 前端 UI 偏好读写。模型配置不在此处——其真源在后端 settings.json，
 * 由设置页经 `/api/settings/model` 读写（见 services/settings）。
 */
export function useSettings() {
    const { theme, updateTheme } = useSettingsStore();

    const setTheme = useCallback(
        (themeValue: ThemeId) => {
            updateTheme(themeValue);
        },
        [updateTheme]
    );

    return { theme, setTheme, themeList };
}
