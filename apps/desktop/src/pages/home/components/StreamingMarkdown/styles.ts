import { colors, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.stream-md': {
            fontFamily: typography['body-md'].fontFamily,
            fontSize: typography['body-md'].fontSize,
            lineHeight: 1.75,

            '& > .x-markdown-light': {
                '--font-size': '16px',
                '--primary-color': colors.primary,
                '--primary-color-hover': colors['primary-active'],
                '--heading-color': colors.ink,
                '--text-color': colors.body,
                '--border-color': colors.hairline,
                '--line-color': colors.hairline,
                '--light-bg': colors['surface-soft'],
                '--table-head-bg': colors['surface-soft'],
                '--table-body-bg': colors.canvas,
                '--margin-ul-ol': '0 0 12px 12px',
                '--margin-li': '0 0 6px 0',

                '& h1, & h2': {
                    fontFamily: typography['heading-serif'],
                    fontSize: 'clamp(22px, 2vw, 28px)',
                    lineHeight: 1.35,
                    letterSpacing: '-0.02em'
                }
            }
        },

        // 每块各自是一个 .x-markdown 根，主题里的 p:first-child / p:last-child 清零会吃掉块间间距，
        // 这里按原整段渲染的相邻元素间距（1em）补回来
        '&.stream-md > .x-markdown + .x-markdown': {
            marginTop: '1em'
        }
    });
});

export default useStyles;
