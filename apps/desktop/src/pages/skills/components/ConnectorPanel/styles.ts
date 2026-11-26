import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.connector-panel': {
            height: '100%',
            overflowY: 'auto',
            padding: `${spacing.md}px var(--extension-gutter) ${spacing.lg}px`,

            '& > *': { maxWidth: 'var(--extension-width)', marginInline: 'auto' },

            '& .connector-panel-heading': { margin: '0 0 6px', fontSize: 24, color: colors.ink },
            '& .connector-panel-section': {
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginTop: 32,
                marginBottom: 12,
                '& h3': { margin: 0 }
            },
            '& .connector-catalog-tools': {
                display: 'flex',
                gap: 16,
                marginBlock: 24,
                '& .connector-catalog-search': { maxWidth: 420, width: '100%' }
            },
            '& .connector-catalog-grid': {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))',
                gap: 16
            },
            '& .connector-app-card': {
                padding: 24,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.lg,
                background: colors['surface-card'],
                transition: 'border-color 160ms ease',
                '&:hover': { borderColor: colors.primary },
                '& h3': { margin: '18px 0 8px', fontSize: 18, color: colors.ink },
                '& p': { margin: '0 0 24px', color: colors.muted, minHeight: 44, lineHeight: 1.7 }
            },
            '& .connector-app-card-top, & .connector-app-card-bottom': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12
            },
            '& .connector-app-icon': {
                display: 'grid',
                placeItems: 'center',
                width: 44,
                height: 44,
                borderRadius: 12,
                fontSize: 25,
                fontWeight: 600,
                background: colors['surface-soft'],
                color: colors.ink
            },
            '& .connector-app-icon-baidu-netdisk': { color: colors.primary },
            '& .connector-app-ready': { fontSize: 13, color: colors.success },
            '@media (max-width: 600px)': {
                '& .connector-panel-toolbar, & .connector-catalog-tools': {
                    alignItems: 'flex-start',
                    flexDirection: 'column'
                }
            },
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
