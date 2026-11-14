import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.app-update-panel': {
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.md,
            marginTop: spacing.md,
            paddingTop: spacing.lg,
            borderTop: `1px solid ${colors.hairline}`,

            '& .app-update-panel-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .app-update-panel-row': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm,
                flexWrap: 'wrap',
                paddingBottom: spacing.sm,
                borderBottom: `1px solid ${colors.hairline}`
            },

            '& .app-update-panel-label': {
                fontWeight: 500,
                color: colors.ink
            },

            '& .app-update-panel-hint': {
                color: colors.muted,
                fontSize: 13
            },

            '& .app-update-panel-error': {
                color: colors.error,
                fontSize: 13
            }
        }
    });
});

export default useStyles;
