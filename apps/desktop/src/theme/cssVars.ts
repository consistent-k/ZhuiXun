import type { ThemeDefinition } from './themes';
import type { ColorKey } from './tokens';

/**
 * 把主题的调色板写入 `document.documentElement` 的 `--color-*` CSS 变量，并设置
 * `data-theme` 属性。所有通过 `theme/tokens` 的 `colors` 访问器消费变量的样式随之换肤。
 * @param theme 当前主题定义
 */
export const applyThemeVars = (theme: ThemeDefinition): void => {
    const root = document.documentElement;
    (Object.keys(theme.palette) as ColorKey[]).forEach((key) => {
        root.style.setProperty(`--color-${key}`, theme.palette[key]);
    });
    root.setAttribute('data-theme', theme.id);
};
