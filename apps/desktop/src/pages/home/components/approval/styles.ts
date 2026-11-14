import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.approval-inline': {
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: spacing.xs,
            minHeight: 36,
            paddingInline: spacing.sm,
            marginBottom: spacing.xs,
            border: `1px solid ${colors.hairline}`,
            borderRadius: rounded.md,
            color: colors.muted,
            fontSize: typography['body-sm'].fontSize,

            '& > .anticon': {
                color: colors.warning
            },
            '& button': {
                marginInlineStart: 'auto',
                color: colors.primary
            }
        },

        '&.approval-card': {
            border: `1px solid ${colors.hairline}`,
            borderLeft: `3px solid ${colors.warning}`,
            borderRadius: rounded.md,
            background: colors['surface-soft'],
            padding: spacing.sm,
            marginBottom: spacing.sm,
            fontSize: typography['body-sm'].fontSize,
            minWidth: 0,

            '&.approval-card--compact': {
                padding: 0,
                marginBottom: 0,
                borderLeftWidth: 1,

                '& .approval-card-bar': {
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: spacing.xs,
                    minHeight: 40,
                    padding: `${spacing.xxs}px ${spacing.xs}px ${spacing.xxs}px ${spacing.sm}px`
                },

                '& .approval-card-heading': {
                    display: 'flex',
                    alignItems: 'center',
                    flex: '1 1 190px',
                    gap: spacing.xs,
                    minWidth: 0
                },

                '& .approval-card-icon': {
                    fontSize: 15
                },

                '& .approval-card-summary': {
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: spacing.xs,
                    minWidth: 0
                },

                '& .approval-card-summary-title': {
                    flexShrink: 0,
                    fontWeight: 500,
                    color: colors.ink
                },

                '& .approval-card-summary-target': {
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: colors.muted,
                    fontFamily: typography.code.fontFamily,
                    fontSize: typography.caption.fontSize,
                    unicodeBidi: 'isolate'
                },

                '& .approval-card-buttons': {
                    marginInlineStart: 'auto',
                    flexShrink: 0,
                    gap: spacing.xxs,

                    '& > button': {
                        height: 26,
                        paddingInline: spacing.xs,
                        fontSize: typography.caption.fontSize
                    }
                },

                '& .approval-card-expanded': {
                    padding: spacing.sm,
                    borderTop: `1px solid ${colors.hairline}`
                },

                '& .approval-card-detail-header': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: spacing.xs,
                    marginBottom: spacing.xxs,
                    color: colors.muted,
                    fontSize: typography.caption.fontSize
                },

                '& .approval-card-request-link': {
                    marginInlineStart: 'auto'
                },

                '& .approval-card-remember': {
                    marginBottom: 0,
                    marginTop: spacing.xs
                }
            },

            '& .approval-card-header': {
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.xs,
                marginBottom: spacing.xs
            },

            '& .approval-card-icon': {
                color: colors.warning,
                fontSize: 18,
                flexShrink: 0
            },

            '& .approval-card-title': {
                margin: 0,
                fontSize: typography['body-md'].fontSize,
                fontWeight: 500,
                color: colors.ink
            },

            '& .approval-card-tag': {
                marginInlineEnd: 0
            },

            '& .approval-card-reason': {
                marginBottom: spacing.xs
            },

            '& .approval-card-scope': {
                display: 'flex',
                alignItems: 'baseline',
                gap: spacing.xs,
                marginBottom: spacing.xs,
                minWidth: 0
            },

            '& .approval-card-scope-label': {
                flexShrink: 0,
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .approval-card-scope-value': {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: typography.code.fontFamily,
                fontSize: typography.caption.fontSize,
                color: colors['body-strong']
            },

            '& .approval-card-detail': {
                marginBottom: spacing.xs,
                maxHeight: 320,
                overflow: 'auto'
            },

            '& .approval-card-command-text': {
                margin: 0,
                padding: `${spacing.xs}px ${spacing.sm}px`,
                background: colors.canvas,
                borderRadius: rounded.sm,
                color: colors.body,
                fontFamily: typography.code.fontFamily,
                fontSize: typography.caption.fontSize,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all'
            },

            '& .approval-card-path': {
                padding: `${spacing.xs}px ${spacing.sm}px`,
                background: colors.canvas,
                borderRadius: rounded.sm,
                color: colors.body,
                fontFamily: typography.code.fontFamily,
                fontSize: typography.caption.fontSize,
                wordBreak: 'break-all'
            },

            '& .approval-card-meta': {
                display: 'flex',
                gap: spacing.xs,
                marginBottom: spacing.xs,
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .approval-card-meta-path': {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },

            '& .approval-card-remember': {
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: spacing.xs,
                marginBottom: spacing.sm
            },

            '& .approval-card-remember-label': {
                fontSize: typography['body-sm'].fontSize,
                color: colors.body
            },

            '& .approval-card-remember-hint': {
                fontSize: typography.caption.fontSize,
                color: colors.muted,

                '& code': {
                    fontFamily: typography.code.fontFamily,
                    color: colors['body-strong']
                }
            },

            '& .approval-card-buttons': {
                display: 'flex',
                justifyContent: 'flex-end',
                gap: spacing.xs
            },

            '& .approval-card-locate': {
                paddingInline: 0
            },

            '& .approval-card-status': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                marginTop: spacing.xs
            },

            '& .approval-card-status-text': {
                fontSize: typography.caption.fontSize,
                color: colors.muted,
                wordBreak: 'break-word'
            },

            '& .approval-card-status-icon-success': {
                color: colors.success
            },

            '& .approval-card-status-icon-error': {
                color: colors.error
            },

            '& .approval-card-status-icon-pending': {
                color: colors.primary
            },

            '& .approval-card-status--denied .approval-card-status-text': {
                color: colors.error
            }
        }
    });
});

export default useStyles;
