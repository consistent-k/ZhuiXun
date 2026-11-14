import type { ThemeConfig } from 'antd';

import { airbnbPalette, claudePalette, zhuixunPalette, vercelPalette, type Palette } from './palettes';
import { rounded, spacing, typography } from './tokens';

/** 主题标识。新增主题在此扩展联合类型并在 {@link themes} 注册即可。 */
export type ThemeId = 'zhuixun' | 'claude' | 'vercel' | 'airbnb';

/** 主题选择器预览色样 */
export interface ThemePreview {
    /** 强调色 */
    primary: string;
    /** 背景底色 */
    background: string;
    /** 辅助色样 */
    accent: string;
}

/** 一套完整主题定义：元信息 + 调色板 + 结构覆写（最终产出 antd ThemeConfig） */
export interface ThemeDefinition {
    /** 主题标识 */
    id: ThemeId;
    /** 展示名 */
    name: string;
    /** 一句话描述 */
    description: string;
    /** 是否暗色主题 */
    isDark: boolean;
    /** 主题选择器预览色样 */
    preview: ThemePreview;
    /** 语义调色板（真实色值） */
    palette: Palette;
    /** 基础圆角（随主题，Vercel 偏锐利） */
    radius: number;
    /** 由调色板与结构 token 生成的 antd 主题配置 */
    config: ThemeConfig;
}

/**
 * 由调色板 + 共享结构 token 生成 antd ThemeConfig。
 * 结构性 token（字体、间距、控件高度、派生圆角）各主题共享，仅颜色与基础圆角随主题变化。
 * @param palette 当前主题语义调色板
 * @param radius 当前主题基础圆角
 * @returns antd ThemeConfig
 */
export const buildAntdConfig = (palette: Palette, radius: number): ThemeConfig => ({
    token: {
        // Colors
        colorPrimary: palette.primary,
        colorPrimaryActive: palette['primary-active'],
        colorPrimaryHover: palette['primary-active'],
        colorPrimaryBg: palette.canvas,
        colorPrimaryBgHover: palette['surface-soft'],
        colorPrimaryBorder: palette.primary,
        colorPrimaryBorderHover: palette['primary-active'],
        colorText: palette.ink,
        colorTextSecondary: palette.muted,
        colorTextTertiary: palette['muted-soft'],
        colorTextQuaternary: palette['muted-soft'],
        colorBgLayout: palette.canvas,
        colorBgContainer: palette.canvas,
        colorBgElevated: palette['surface-card'],
        colorBgSpotlight: palette['surface-dark'],
        colorBorder: palette.hairline,
        colorBorderSecondary: palette['hairline-soft'],
        colorSuccess: palette.success,
        colorWarning: palette.warning,
        colorError: palette.error,

        // Typography
        fontFamily: typography['body-md'].fontFamily,
        fontSize: typography['body-md'].fontSize,
        fontSizeHeading1: typography['display-xl'].fontSize,
        fontSizeHeading2: typography['display-lg'].fontSize,
        fontSizeHeading3: typography['display-md'].fontSize,
        fontSizeHeading4: typography['display-sm'].fontSize,
        fontSizeHeading5: typography['title-lg'].fontSize,
        lineHeight: typography['body-md'].lineHeight,
        lineHeightHeading1: typography['display-xl'].lineHeight,
        lineHeightHeading2: typography['display-lg'].lineHeight,
        lineHeightHeading3: typography['display-md'].lineHeight,
        lineHeightHeading4: typography['display-sm'].lineHeight,
        lineHeightHeading5: typography['title-lg'].lineHeight,

        // Spacing
        padding: spacing.md,
        paddingXS: spacing.xs,
        paddingSM: spacing.sm,
        paddingMD: spacing.md,
        paddingLG: spacing.lg,
        paddingXL: spacing.xl,
        margin: spacing.md,
        marginXS: spacing.xs,
        marginSM: spacing.sm,
        marginMD: spacing.md,
        marginLG: spacing.lg,
        marginXL: spacing.xl,

        // Border Radius
        borderRadius: radius,
        borderRadiusXS: rounded.xs,
        borderRadiusSM: rounded.sm,
        borderRadiusLG: rounded.lg,

        // Control Height
        controlHeight: 40,
        controlHeightSM: 32,
        controlHeightLG: 48
    },
    components: {
        Button: {
            colorPrimary: palette.primary,
            colorPrimaryHover: palette['primary-active'],
            colorPrimaryActive: palette['primary-active'],
            colorPrimaryBg: palette.canvas,
            colorPrimaryBgHover: palette['surface-soft'],
            colorPrimaryBorder: palette.primary,
            colorPrimaryBorderHover: palette['primary-active'],
            defaultBg: palette.canvas,
            defaultBorderColor: palette.hairline,
            defaultColor: palette.ink,
            defaultHoverBg: palette['surface-soft'],
            defaultHoverBorderColor: palette['primary-active'],
            defaultHoverColor: palette.ink,
            defaultActiveBg: palette['surface-card'],
            defaultActiveBorderColor: palette.primary,
            defaultActiveColor: palette.ink,
            borderRadius: radius,
            controlHeight: 40,
            controlHeightSM: 32,
            controlHeightLG: 48,
            fontWeight: 500,
            primaryShadow: 'none',
            defaultShadow: 'none'
        },
        Input: {
            colorBgContainer: palette.canvas,
            colorBorder: palette.hairline,
            colorPrimary: palette.primary,
            colorPrimaryHover: palette['primary-active'],
            activeBorderColor: palette.primary,
            hoverBorderColor: palette['primary-active'],
            activeShadow: `0 0 0 3px ${palette.primary}26`,
            borderRadius: radius,
            controlHeight: 40,
            controlHeightSM: 32,
            controlHeightLG: 48
        },
        Card: {
            colorBgContainer: palette.canvas,
            colorBorderSecondary: palette['hairline-soft'],
            borderRadiusLG: rounded.lg,
            paddingLG: spacing.xl
        },
        List: {
            colorBgContainer: palette.canvas,
            colorBorderSecondary: palette['hairline-soft']
        },
        Menu: {
            // 全局 colorPrimaryBg 被覆写成 canvas，导致 Menu 选中项背景与底色同色、选中态不可见。
            // 这里显式给出菜单项的 hover / 选中态配色，让选中项有明显高亮。
            itemBg: 'transparent',
            itemColor: palette.body,
            itemHoverBg: palette['surface-soft'],
            itemHoverColor: palette.ink,
            itemSelectedBg: palette['surface-card'],
            itemSelectedColor: palette.primary,
            itemActiveBg: palette['surface-card']
        },
        Modal: {
            contentBg: palette.canvas,
            headerBg: palette.canvas,
            titleColor: palette.ink,
            colorIcon: palette.muted,
            colorIconHover: palette.ink,
            borderRadiusLG: rounded.lg
        },
        Tooltip: {
            colorBgSpotlight: palette['surface-dark'],
            colorTextLightSolid: palette['on-dark']
        },
        Typography: {
            colorText: palette.ink,
            colorTextDescription: palette.body,
            colorTextSecondary: palette.muted,
            colorTextTertiary: palette['muted-soft'],
            fontFamily: typography['body-md'].fontFamily,
            fontWeightStrong: 500,
            fontSizeHeading1: typography['display-xl'].fontSize,
            fontSizeHeading2: typography['display-lg'].fontSize,
            fontSizeHeading3: typography['display-md'].fontSize,
            fontSizeHeading4: typography['display-sm'].fontSize,
            fontSizeHeading5: typography['title-lg'].fontSize,
            lineHeightHeading1: typography['display-xl'].lineHeight,
            lineHeightHeading2: typography['display-lg'].lineHeight,
            lineHeightHeading3: typography['display-md'].lineHeight,
            lineHeightHeading4: typography['display-sm'].lineHeight,
            lineHeightHeading5: typography['title-lg'].lineHeight
        }
    }
});

/** 组装一套主题定义：预览色样取自调色板，config 由调色板 + 圆角生成 */
const defineTheme = (
    meta: Pick<ThemeDefinition, 'id' | 'name' | 'description' | 'isDark' | 'radius'>,
    palette: Palette
): ThemeDefinition => ({
    ...meta,
    palette,
    preview: {
        primary: palette.primary,
        background: palette.canvas,
        accent: palette['surface-card']
    },
    config: buildAntdConfig(palette, meta.radius)
});

/** 主题注册表。新增主题在此追加一项即可，业务组件无需改动。 */
export const themes: Record<ThemeId, ThemeDefinition> = {
    zhuixun: defineTheme(
        {
            id: 'zhuixun',
            name: '追寻',
            description: '暖白底、墨蓝字与钴蓝操作色（默认）',
            isDark: false,
            radius: 8
        },
        zhuixunPalette
    ),
    vercel: defineTheme(
        { id: 'vercel', name: 'Vercel', description: '极简黑白，锐利克制', isDark: false, radius: 6 },
        vercelPalette
    ),
    claude: defineTheme(
        { id: 'claude', name: 'Claude', description: '温暖中性色系，陶红色强调', isDark: false, radius: 12 },
        claudePalette
    ),
    airbnb: defineTheme(
        { id: 'airbnb', name: 'Airbnb', description: 'Rausch 红强调，中性灰底', isDark: false, radius: 12 },
        airbnbPalette
    )
};

/** 默认主题标识，用于缺省与非法值兜底 */
export const DEFAULT_THEME_ID: ThemeId = 'zhuixun';

/** 全部主题列表，供主题选择器渲染 */
export const themeList: ThemeDefinition[] = Object.values(themes);

/**
 * 按标识取主题定义，未知标识回退默认主题。
 * @param themeId 主题标识
 * @returns 对应主题定义，缺失时为默认主题
 */
export const getTheme = (themeId: ThemeId): ThemeDefinition => themes[themeId] ?? themes[DEFAULT_THEME_ID];
