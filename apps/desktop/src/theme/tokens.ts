/**
 * zhuixun Theme Configuration
 * Based on DESIGN.md - Warm editorial interface for an AI assistant
 */

/**
 * 语义色访问器。值为 CSS 变量引用 `var(--color-<key>)`，真实色值由当前主题调色板
 * 在运行时写入 `document.documentElement`（见 `theme/cssVars.ts` 与 `theme/themes.ts`）。
 * 组件 `styles.ts` 直接消费本对象，故切换主题时无需逐个改样式——变量值随主题变化即可。
 * 注意：antd token 需要真实色值做派生/alpha 计算，不能用本访问器，须用主题调色板的 hex。
 */
export const colors = {
    // Brand & Accent
    primary: 'var(--color-primary)',
    'primary-active': 'var(--color-primary-active)',
    'primary-disabled': 'var(--color-primary-disabled)',

    // Surface
    canvas: 'var(--color-canvas)',
    'surface-soft': 'var(--color-surface-soft)',
    'surface-card': 'var(--color-surface-card)',
    'surface-cream-strong': 'var(--color-surface-cream-strong)',
    'surface-dark': 'var(--color-surface-dark)',
    'surface-dark-elevated': 'var(--color-surface-dark-elevated)',
    'surface-dark-soft': 'var(--color-surface-dark-soft)',

    // Text
    ink: 'var(--color-ink)',
    'body-strong': 'var(--color-body-strong)',
    body: 'var(--color-body)',
    muted: 'var(--color-muted)',
    'muted-soft': 'var(--color-muted-soft)',
    'on-primary': 'var(--color-on-primary)',
    'on-dark': 'var(--color-on-dark)',
    'on-dark-soft': 'var(--color-on-dark-soft)',

    // Hairline
    hairline: 'var(--color-hairline)',
    'hairline-soft': 'var(--color-hairline-soft)',

    // Semantic
    success: 'var(--color-success)',
    warning: 'var(--color-warning)',
    error: 'var(--color-error)',

    // Accent
    'accent-teal': 'var(--color-accent-teal)',
    'accent-amber': 'var(--color-accent-amber)'
} as const;

/** 语义色 key，与 CSS 变量 `--color-<key>` 及各主题调色板一一对应 */
export type ColorKey = keyof typeof colors;

// Typography tokens from DESIGN.md
export const typography = {
    'heading-serif': '"Songti SC", "Noto Serif CJK SC", SimSun, Georgia, serif',
    // Display fonts (serif)
    'display-xl': {
        fontFamily: '"Cormorant Garamond", "EB Garamond", "Tiempos Headline", serif',
        fontSize: 64,
        fontWeight: 400,
        lineHeight: 1.05,
        letterSpacing: '-1.5px'
    },
    'display-lg': {
        fontFamily: '"Cormorant Garamond", "EB Garamond", "Tiempos Headline", serif',
        fontSize: 48,
        fontWeight: 400,
        lineHeight: 1.1,
        letterSpacing: '-1px'
    },
    'display-md': {
        fontFamily: '"Cormorant Garamond", "EB Garamond", "Tiempos Headline", serif',
        fontSize: 36,
        fontWeight: 400,
        lineHeight: 1.15,
        letterSpacing: '-0.5px'
    },
    'display-sm': {
        fontFamily: '"Cormorant Garamond", "EB Garamond", "Tiempos Headline", serif',
        fontSize: 28,
        fontWeight: 400,
        lineHeight: 1.2,
        letterSpacing: '-0.3px'
    },

    // Body fonts (sans-serif)
    'title-lg': {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 22,
        fontWeight: 500,
        lineHeight: 1.3,
        letterSpacing: '0'
    },
    'title-md': {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 18,
        fontWeight: 500,
        lineHeight: 1.4,
        letterSpacing: '0'
    },
    'title-sm': {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 16,
        fontWeight: 500,
        lineHeight: 1.4,
        letterSpacing: '0'
    },
    'body-md': {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 16,
        fontWeight: 400,
        lineHeight: 1.55,
        letterSpacing: '0'
    },
    'body-sm': {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 14,
        fontWeight: 400,
        lineHeight: 1.55,
        letterSpacing: '0'
    },
    caption: {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1.4,
        letterSpacing: '0'
    },
    'caption-uppercase': {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        fontWeight: 500,
        lineHeight: 1.4,
        letterSpacing: '1.5px'
    },
    code: {
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 14,
        fontWeight: 400,
        lineHeight: 1.6,
        letterSpacing: '0'
    },
    button: {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 14,
        fontWeight: 500,
        lineHeight: 1,
        letterSpacing: '0'
    },
    'nav-link': {
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 14,
        fontWeight: 500,
        lineHeight: 1.4,
        letterSpacing: '0'
    }
} as const;

// Spacing tokens from DESIGN.md
export const spacing = {
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
    section: 96
} as const;

// Border radius tokens from DESIGN.md
export const rounded = {
    xs: 4,
    sm: 6,
    md: 8,
    lg: 12,
    xl: 16,
    pill: 9999,
    full: 9999
} as const;
