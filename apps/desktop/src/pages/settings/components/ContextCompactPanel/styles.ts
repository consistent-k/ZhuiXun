import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.context-compact-panel': {
            '& .context-compact-panel-row': {
                padding: spacing.md,
                background: colors['surface-soft'],
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md
            },

            '& .context-compact-panel-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .context-compact-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginTop: spacing.xxs,
                maxWidth: 560
            },

            '& .context-compact-panel-field': {
                marginTop: spacing.md,
                padding: spacing.md,
                border: `1px solid ${colors.hairline}`,
                borderRadius: 8
            },

            '& .context-compact-panel-field-label': {
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .context-compact-panel-value': {
                color: colors.primary,
                fontSize: typography['body-md'].fontSize
            },

            '& .context-compact-panel-slider': {
                marginTop: spacing.xs,
                maxWidth: 560
            },

            '& .context-compact-panel-save': {
                marginTop: spacing.lg
            }
        }
    });
});

export default useStyles;
