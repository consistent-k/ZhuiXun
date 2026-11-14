import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

/**
 * 工具 presenter 共用样式。
 *
 * 这些类只出现在 ToolCardShell 的详情区（已展开时才挂载），因此可以放心使用
 * 限高滚动与等宽字体；收起态不会触发这些 DOM。
 */
const useStyles = createStyles(({ css }) => {
    return css({
        '&.tool-presenter': {
            minWidth: 0,

            '& .tool-presenter-empty': {
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .tool-presenter-note': {
                marginTop: spacing.xxs,
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .tool-presenter-code': {
                maxHeight: 320,
                overflow: 'auto',
                borderRadius: rounded.sm,
                background: colors.canvas,

                '& pre': {
                    margin: 0
                }
            },

            '& .tool-presenter-pre': {
                margin: 0,
                padding: spacing.xs,
                maxHeight: 320,
                overflow: 'auto',
                borderRadius: rounded.sm,
                background: colors.canvas,
                color: colors.body,
                fontFamily: typography.code.fontFamily,
                fontSize: typography.caption.fontSize,
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all'
            },

            '& .tool-presenter-list': {
                margin: 0,
                padding: 0,
                listStyle: 'none',
                maxHeight: 320,
                overflow: 'auto',
                borderRadius: rounded.sm,
                background: colors.canvas,

                '& .tool-presenter-list-item': {
                    display: 'flex',
                    alignItems: 'center',
                    gap: spacing.xs,
                    padding: `${spacing.xxs}px ${spacing.xs}px`,
                    fontFamily: typography.code.fontFamily,
                    fontSize: typography.caption.fontSize,
                    color: colors.body,

                    '& + .tool-presenter-list-item': {
                        borderTop: `1px solid ${colors['hairline-soft']}`
                    },

                    '& .tool-presenter-list-icon': {
                        color: colors.muted,
                        flexShrink: 0
                    },

                    '& .tool-presenter-list-name': {
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                    }
                }
            },

            '& .tool-presenter-diff': {
                maxHeight: 360,
                overflow: 'auto',
                borderRadius: rounded.sm,
                background: colors.canvas,
                fontFamily: typography.code.fontFamily,
                fontSize: typography.caption.fontSize,
                lineHeight: 1.55,

                '& .tool-presenter-diff-line': {
                    display: 'flex',
                    minWidth: 'min-content',
                    padding: `0 ${spacing.xs}px`,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',

                    '& .tool-presenter-diff-gutter': {
                        flexShrink: 0,
                        width: 16,
                        color: colors.muted,
                        userSelect: 'none'
                    },

                    '&.is-add': {
                        color: colors.success,
                        background: colors['surface-soft']
                    },

                    '&.is-remove': {
                        color: colors.error,
                        background: colors['surface-soft']
                    },

                    '&.is-context': {
                        color: colors.body
                    }
                }
            },

            '& .tool-presenter-json': {
                '& .tool-presenter-json-section + .tool-presenter-json-section': {
                    marginTop: spacing.sm
                },

                '& .tool-presenter-json-title': {
                    margin: `0 0 ${spacing.xxs}`,
                    color: colors.muted,
                    fontSize: typography.caption.fontSize,
                    fontWeight: 500
                }
            },

            '& .tool-presenter-markdown': {
                maxHeight: 360,
                overflow: 'auto',

                '& .x-markdown-light': {
                    fontSize: typography['body-sm'].fontSize
                }
            },

            '& .tool-presenter-error': {
                color: colors.error
            }
        }
    });
});

export default useStyles;
