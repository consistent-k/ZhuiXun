import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.memory-panel': {
            '& .memory-panel-row': {
                padding: spacing.md,
                background: colors['surface-soft'],
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md
            },

            '& .memory-panel-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .memory-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginTop: spacing.xxs,

                '&.memory-panel-hint--block': {
                    marginTop: spacing.md
                }
            },

            '& .memory-panel-autorow': {
                display: 'flex',
                gap: spacing.md,
                alignItems: 'center',
                flexWrap: 'wrap',
                marginTop: spacing.sm,
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize
            },

            '& .memory-panel-auto-item': {
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacing.xxs
            },

            '& .memory-panel-items': {
                marginTop: spacing.md
            }
        }
    });
});

export default useStyles;
