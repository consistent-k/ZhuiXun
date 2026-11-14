import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.term': {
            marginTop: spacing.xxs,

            // trace 行：折叠触发器 + 旁置操作按钮
            '& .term-row': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xxs
            },

            '& .term-trigger': {
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                padding: `${spacing.xxs}px ${spacing.xs}px`,
                border: 'none',
                background: 'transparent',
                borderRadius: rounded.sm,
                cursor: 'pointer',
                color: colors.body,
                fontFamily: typography['body-sm'].fontFamily,
                fontSize: typography['body-sm'].fontSize,
                textAlign: 'left',

                '&:hover': {
                    background: colors['surface-soft']
                }
            },

            // 无输出（不可展开）时标题行为静态展示，去掉指针/hover
            '& .term-trigger--static': {
                cursor: 'default',

                '&:hover': {
                    background: 'transparent'
                }
            },

            '& .term-chevron': {
                fontSize: 10,
                color: colors.muted,
                transition: 'transform 0.15s ease',
                flex: 'none'
            },

            '& .term-icon': {
                color: colors.primary,
                flex: 'none'
            },

            // 标题即命令：等宽、单行省略（完整命令见 title 悬浮）
            '& .term-title': {
                flex: 1,
                minWidth: 0,
                fontFamily: typography.code.fontFamily,
                color: colors.ink,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
            },

            '& .term-status': {
                flex: 'none',
                color: colors.primary,
                fontSize: typography['body-sm'].fontSize
            },

            '& .term-actions': {
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xxs
            },

            '&.term--open .term-chevron': {
                transform: 'rotate(180deg)'
            },

            // 输出代码块：换行 + 限高（max-h-64 ≈ 256px）滚动
            '& .term-content': {
                marginTop: spacing.xxs,
                maxHeight: 256,
                overflow: 'auto',
                borderRadius: rounded.sm,

                '& .term-code': {
                    margin: 0
                },

                // CodeHighlighter 把 white-space:pre 与浅色 background/color 都写成了 pre/code 的**行内样式**，
                // 只能用 !important 覆盖：换行 + 深色终端背景 + 浅色文字。
                // whiteSpace/wordBreak 是严格枚举类型，用 as 收窄以通过 CSSObject 校验；background/color 接受任意字符串。
                '& pre': {
                    background: '#1e1e22 !important',
                    color: '#d4d4d4 !important'
                },

                '& pre, & code': {
                    whiteSpace: 'pre-wrap !important' as 'pre-wrap',
                    wordBreak: 'break-all !important' as 'break-all',
                    fontSize: `${typography.caption.fontSize}px !important`,
                    lineHeight: '1.5 !important'
                }
            }
        }
    });
});

export default useStyles;
