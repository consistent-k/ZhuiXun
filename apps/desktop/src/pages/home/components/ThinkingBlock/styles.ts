import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.thinking-block': {
            marginBottom: spacing.sm,

            // Think 默认给状态行 width: fit-content，长摘要会把整行顶出卡片；
            // 改成占满容器，status-text 才能作为可收缩的 flex 项把 summary 省略号截断。
            '& .zhuixun-think-status-wrapper': {
                width: '100%',
                minWidth: 0
            },

            // Think 的标题容器默认按内容撑开，summary 会把整行顶出卡片；
            // 让 status-text 成为可收缩的 flex 项，title 占满它，summary 才能在剩余宽度里省略号截断。
            '& .zhuixun-think-status-text': {
                flex: '1 1 auto',
                minWidth: 0,
                overflow: 'hidden'
            },

            '& .thinking-title': {
                display: 'flex',
                alignItems: 'baseline',
                gap: spacing.xs,
                width: '100%',
                minWidth: 0
            },

            '& .thinking-label': {
                flexShrink: 0,

                '&.is-running': {
                    color: colors.primary
                }
            },

            '& .thinking-summary': {
                flex: '1 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            // 思考正文相对正式回答弱化：更小字号 + 降透明度，和最终答案做视觉区分
            '& .x-markdown-light': {
                fontSize: typography['body-sm'].fontSize,
                opacity: 0.82
            },

            '@media (prefers-reduced-motion: reduce)': {
                '& .zhuixun-think-content': {
                    transition: 'none !important',
                    animation: 'none !important'
                }
            }
        }
    });
});

export default useStyles;
