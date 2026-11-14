import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        // Mermaid 图形容器：限制在气泡宽度内，横向溢出可滚动（大图不撑破布局，配合组件自带缩放）
        '&.mermaid-code-block': {
            margin: `${spacing.xs}px 0`,
            border: `1px solid ${colors.hairline}`,
            borderRadius: rounded.md,
            overflow: 'auto',
            background: colors.canvas,
            maxWidth: '100%'
        },

        '&.svg-code-block': {
            margin: `${spacing.xs}px 0`,
            border: `1px solid ${colors.hairline}`,
            borderRadius: rounded.md,
            overflow: 'hidden',
            background: colors.canvas,

            '& .svg-code-block-toolbar': {
                padding: `${spacing.xxs}px ${spacing.xs}px`,
                borderBottom: `1px solid ${colors['hairline-soft']}`,
                background: colors['surface-soft']
            },

            '& .svg-code-block-badge': {
                fontFamily: typography['caption-uppercase'].fontFamily,
                fontSize: typography['caption-uppercase'].fontSize,
                letterSpacing: typography['caption-uppercase'].letterSpacing,
                color: colors.muted
            },

            '& .svg-code-block-preview': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: spacing.md,
                // 棋盘格底纹：透明背景的 SVG 也能看清边界
                backgroundColor: colors['surface-card'],
                backgroundImage:
                    'linear-gradient(45deg, rgba(0,0,0,0.04) 25%, transparent 25%),' +
                    'linear-gradient(-45deg, rgba(0,0,0,0.04) 25%, transparent 25%),' +
                    'linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.04) 75%),' +
                    'linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.04) 75%)',
                backgroundSize: '16px 16px',
                backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',

                '& img': {
                    maxWidth: '100%',
                    maxHeight: 320,
                    objectFit: 'contain'
                }
            },

            // 源码视图直接用 CodeHighlighter，去掉它的圆角以贴合外层容器
            '& .svg-code-block-source': {
                borderRadius: 0
            }
        }
    });
});

export default useStyles;
