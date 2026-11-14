import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.approval-dock': {
            width: '100%',
            maxWidth: 'calc(var(--chat-column-width) + 2 * var(--chat-gutter))',
            marginInline: 'auto',
            padding: `${spacing.sm}px var(--chat-gutter) 0`,
            maxHeight: 'min(42vh, 360px)',
            overflowY: 'auto',
            background: colors.canvas,
            outline: 'none',

            '&:focus-visible': {
                outline: `2px solid ${colors.primary}`,
                outlineOffset: -2
            },

            '& .approval-dock-header': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                flexWrap: 'wrap',
                marginBottom: spacing.xs
            },

            '& .approval-dock-count': {
                color: colors.muted,
                fontSize: typography.caption.fontSize
            },

            '& .approval-dock-queue': {
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacing.xs,
                margin: `0 0 ${spacing.xs}`,
                padding: 0,
                listStyle: 'none'
            },

            '& .approval-dock-queue-item': {
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacing.xxs,
                padding: `${spacing.xxs}px ${spacing.xs}px`,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.pill,
                background: 'transparent',
                color: colors.muted,
                fontSize: typography.caption.fontSize,
                cursor: 'pointer',

                '&:hover': {
                    color: colors.body,
                    borderColor: colors['hairline-soft']
                },

                '&.is-active': {
                    color: colors.primary,
                    borderColor: colors.primary
                }
            },

            '& .approval-dock-question': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                padding: `${spacing.xs}px ${spacing.sm}px`,
                marginBottom: spacing.sm,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.md,
                background: colors['surface-soft'],
                color: colors.body,
                fontSize: typography['body-sm'].fontSize
            }
        }
    });
});

export default useStyles;
