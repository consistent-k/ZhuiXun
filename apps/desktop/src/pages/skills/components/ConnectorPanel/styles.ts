import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.connector-panel': {
            height: '100%',
            overflowY: 'auto',
            padding: `${spacing.md}px var(--extension-gutter) ${spacing.lg}px`,

            '& > *': { maxWidth: 'var(--extension-width)', marginInline: 'auto' },

            '& .connector-panel-toolbar': {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: spacing.md
            },

            '& .connector-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize
            },

            '& .connector-panel-server-card': {
                marginBottom: spacing.xs,
                borderRadius: rounded.lg
            },

            '& .connector-panel-card-header': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: spacing.xs
            },

            '& .connector-panel-card-title': {
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.xs,
                minWidth: 0,
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .connector-panel-card-meta': {
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.sm,
                marginTop: spacing.xs,
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                wordBreak: 'break-all'
            },

            '& .connector-panel-error': {
                color: colors.error
            },

            '& .connector-panel-tool-badge': {
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacing.xxs,
                padding: `${spacing.xxs}px ${spacing.xs}px`,
                background: colors['surface-soft'],
                borderRadius: rounded.xs,
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            }
        }
    });
});

export default useStyles;
