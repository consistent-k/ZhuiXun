import type { ColorKey } from './tokens';

export const zhuixunPalette: Palette = {
    primary: '#214bc1',
    'primary-active': '#183a9e',
    'primary-disabled': '#dce3f4',

    canvas: '#fbfaf7',
    'surface-soft': '#f0eee7',
    'surface-card': '#e8e5dc',
    'surface-cream-strong': '#d5d1c5',
    'surface-dark': '#202b49',
    'surface-dark-elevated': '#2b385a',
    'surface-dark-soft': '#17203a',

    ink: '#202536',
    'body-strong': '#313747',
    body: '#414656',
    muted: '#5d6170',
    'muted-soft': '#666a75',
    'on-primary': '#ffffff',
    'on-dark': '#ffffff',
    'on-dark-soft': '#c3cbde',

    hairline: '#dedbd1',
    'hairline-soft': '#e8e5dc',

    success: '#347351',
    warning: '#8b580f',
    error: '#aa353b',

    'accent-teal': '#408779',
    'accent-amber': '#a96921'
};

/** 一套主题的语义调色板：覆盖全部语义色 key，提供真实色值（hex / rgba） */
export type Palette = Record<ColorKey, string>;

/**
 * Claude（默认）暖色调色板。`claude` 主题的核心色（陶红强调 + 暖中性底），
 */
export const claudePalette: Palette = {
    primary: '#c96442',
    'primary-active': '#b05438',
    'primary-disabled': '#e6dfd8',

    canvas: '#f5f4ed',
    'surface-soft': '#efece3',
    'surface-card': '#e8e6dc',
    'surface-cream-strong': '#e0ddd0',
    'surface-dark': '#181715',
    'surface-dark-elevated': '#252320',
    'surface-dark-soft': '#1f1e1b',

    ink: '#141413',
    'body-strong': '#252523',
    body: '#3d3d3a',
    muted: '#5e5d59',
    'muted-soft': '#87867f',
    'on-primary': '#ffffff',
    'on-dark': '#faf9f5',
    'on-dark-soft': '#a09d96',

    hairline: '#f0eee6',
    'hairline-soft': '#e8e6dc',

    success: '#5db872',
    warning: '#d4a017',
    error: '#c64545',

    'accent-teal': '#5db8a6',
    'accent-amber': '#e8a55a'
};

/**
 * Vercel 极简黑白调色板。
 * 语义色与点缀色沿用项目统一值。
 */
export const vercelPalette: Palette = {
    primary: '#171717',
    'primary-active': '#000000',
    'primary-disabled': '#e5e5e5',

    canvas: '#ffffff',
    'surface-soft': '#fafafa',
    'surface-card': '#f5f5f5',
    'surface-cream-strong': '#ebebeb',
    'surface-dark': '#171717',
    'surface-dark-elevated': '#262626',
    'surface-dark-soft': '#1f1f1f',

    ink: '#171717',
    'body-strong': '#262626',
    body: '#404040',
    muted: '#4d4d4d',
    'muted-soft': '#666666',
    'on-primary': '#ffffff',
    'on-dark': '#fafafa',
    'on-dark-soft': '#a3a3a3',

    hairline: 'rgba(0, 0, 0, 0.08)',
    'hairline-soft': 'rgba(0, 0, 0, 0.04)',

    success: '#5db872',
    warning: '#d4a017',
    error: '#c64545',

    'accent-teal': '#5db8a6',
    'accent-amber': '#e8a55a'
};

/**
 * Airbnb Rausch 调色板。
 * 语义色与点缀色沿用项目统一值。
 */
export const airbnbPalette: Palette = {
    primary: '#ff385c',
    'primary-active': '#e01e4f',
    'primary-disabled': '#ffd0da',

    canvas: '#ffffff',
    'surface-soft': '#f7f7f7',
    'surface-card': '#f2f2f2',
    'surface-cream-strong': '#ebebeb',
    'surface-dark': '#222222',
    'surface-dark-elevated': '#2b2b2b',
    'surface-dark-soft': '#262626',

    ink: '#222222',
    'body-strong': '#333333',
    body: '#4a4a4a',
    muted: '#6a6a6a',
    'muted-soft': '#929292',
    'on-primary': '#ffffff',
    'on-dark': '#ffffff',
    'on-dark-soft': '#b0b0b0',

    hairline: '#c1c1c1',
    'hairline-soft': '#e8e8e8',

    success: '#5db872',
    warning: '#d4a017',
    error: '#c64545',

    'accent-teal': '#5db8a6',
    'accent-amber': '#e8a55a'
};
