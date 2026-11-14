import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.activity-group': {
            border: `1px solid ${colors.hairline}`,
            borderRadius: rounded.md,
            background: 'transparent',
            padding: `${spacing.xxs}px ${spacing.sm}px`,
            marginBottom: spacing.xs,

            '&:hover, &:focus-within, &.has-attention': {
                background: colors['surface-soft']
            },

            '&.has-attention': {
                borderLeft: `2px solid ${colors.warning}`
            },

            '& .activity-group-header': {
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
                cursor: 'pointer'
            },

            '& .activity-group-icon': {
                flexShrink: 0,
                color: colors.primary
            },

            '& .activity-group-label': {
                flexShrink: 0,
                color: colors.ink,
                fontWeight: 500,
                fontSize: typography['body-sm'].fontSize
            },

            '& .activity-group-duration': {
                flexShrink: 0,
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .activity-group-counts': {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .activity-group-running': {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: colors.primary,
                fontFamily: typography.code.fontFamily,
                fontSize: typography.caption.fontSize
            },

            '& .activity-group-auto': {
                flexShrink: 0,
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .activity-group-attention': {
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: colors.warning,
                fontSize: typography.caption.fontSize
            },

            '& .activity-group-chevron': {
                flexShrink: 0,
                marginLeft: 'auto',
                color: colors.muted,
                transition: 'transform 0.15s ease',
                transform: 'rotate(0deg)',

                '&.is-expanded': {
                    transform: 'rotate(180deg)'
                }
            },

            '& .activity-group-body': {
                marginTop: spacing.xs,
                paddingTop: spacing.xs,
                paddingLeft: spacing.md,
                borderTop: `1px solid ${colors['hairline-soft']}`,
                borderLeft: `1px solid ${colors['hairline-soft']}`
            },

            // 组内最后一张卡不再额外留白，避免组底部出现双倍间距
            '& .activity-group-body > .tool-card:last-child': {
                marginBottom: 0
            },

            '@media (prefers-reduced-motion: reduce)': {
                '& .activity-group-chevron': {
                    transition: 'none'
                }
            }
        }
    });
});

export default useStyles;
