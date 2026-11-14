import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.env-panel': {
            '& .env-panel-row': {
                flexWrap: 'wrap',
                paddingBottom: spacing.sm,
                borderBottom: `1px solid ${colors.hairline}`,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: spacing.md
            },

            '& .env-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginTop: spacing.xxs,
                maxWidth: 560
            },

            '& .env-panel-list-header': {
                marginTop: spacing.lg,
                marginBottom: spacing.sm,
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['body-md'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .env-panel-list': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xs
            },

            '& .env-panel-item': {
                flexWrap: 'wrap',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md,
                padding: `${spacing.sm}px ${spacing.md}px`,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.md,
                background: colors.canvas
            },

            '& .env-panel-item-main': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                minWidth: 0
            },

            '& .env-panel-item-key': {
                fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
                fontSize: typography['body-sm'].fontSize,
                color: colors['body-strong'],
                wordBreak: 'break-all'
            },

            '& .env-panel-item-tag': {
                flex: '0 0 auto'
            },

            '& .env-panel-item-meta': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                flex: '0 0 auto'
            }
        }
    });
});

export default useStyles;
