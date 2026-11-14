import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.channel-panel': {
            '& .channel-panel-toolbar': {
                flexWrap: 'wrap',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md,
                marginBottom: spacing.md
            },

            '& .channel-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize
            },

            '& .channel-panel-alert': {
                marginBottom: spacing.md
            },

            '& .channel-panel-list': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xs
            },

            '& .channel-panel-card': {
                borderRadius: rounded.lg
            },

            '& .channel-panel-card-head': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                marginBottom: spacing.xs
            },

            '& .channel-panel-card-name': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .channel-panel-card-info': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginBottom: spacing.sm,

                '& > div': {
                    lineHeight: 1.7
                }
            }
        }
    });
});

export default useStyles;
