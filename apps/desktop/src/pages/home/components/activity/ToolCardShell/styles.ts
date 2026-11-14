import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.tool-card': {
            border: `1px solid ${colors.hairline}`,
            borderRadius: rounded.md,
            background: 'transparent',
            padding: `${spacing.xxs}px ${spacing.sm}px`,
            marginBottom: spacing.xs,
            fontSize: typography['body-sm'].fontSize,
            minWidth: 0,

            '&:has(.tool-card-header:not(:disabled):hover), &:focus-within': {
                background: colors['surface-soft']
            },

            '& .tool-card-header': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                width: '100%',
                minWidth: 0,
                minHeight: 28,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',

                '&:disabled': {
                    cursor: 'default',
                    opacity: 1
                }
            },

            '& .tool-card-icon': {
                flexShrink: 0,
                color: colors.primary,
                display: 'inline-flex'
            },

            '& .tool-card-kind': {
                flexShrink: 0,
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .tool-card-primary': {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: colors.ink,
                fontWeight: 500,

                '& code': {
                    fontFamily: typography.code.fontFamily,
                    fontSize: typography.caption.fontSize
                }
            },

            '& .tool-card-secondary': {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .tool-card-source': {
                flexShrink: 0,
                marginInlineEnd: 0
            },

            '& .tool-card-status': {
                flexShrink: 0,
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: typography.caption.fontSize
            },

            '& .tool-card-status--preparing, & .tool-card-status--running': {
                color: colors.primary
            },

            '& .tool-card-status--waiting-approval, & .tool-card-status--warning': {
                color: colors.warning
            },

            '& .tool-card-status--error, & .tool-card-status--denied': {
                color: colors.error
            },

            '& .tool-card-status--success': {
                color: colors.success
            },

            '& .tool-card-status--canceled': {
                color: colors.muted
            },

            '& .tool-card-chevron': {
                flexShrink: 0,
                color: colors.muted,
                transition: 'transform 0.15s ease',
                transform: 'rotate(0deg)',

                '&.is-expanded': {
                    transform: 'rotate(180deg)'
                }
            },

            '& .tool-card-body': {
                marginTop: spacing.xs,
                paddingTop: spacing.xs,
                borderTop: `1px solid ${colors['hairline-soft']}`
            },

            '@media (prefers-reduced-motion: reduce)': {
                '& .tool-card-chevron': {
                    transition: 'none'
                }
            }
        }
    });
});

export default useStyles;
