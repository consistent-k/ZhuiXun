import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.skill-panel': {
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,

            '& .skill-panel-toolbar': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.sm,
                flexWrap: 'wrap',
                padding: `${spacing.md}px var(--extension-gutter)`
            },

            '& .skill-panel-count': {
                fontSize: typography.caption.fontSize,
                color: colors.muted
            },

            '& .skill-panel-search-input': {
                width: 'clamp(140px, 20vw, 240px)'
            },

            '& .skill-panel-category-bar': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                padding: `0 var(--extension-gutter) ${spacing.sm}px`,
                overflowX: 'auto',
                scrollbarWidth: 'none',

                '&::-webkit-scrollbar': {
                    display: 'none'
                }
            },

            '& .skill-panel-category-item': {
                flexShrink: 0,
                padding: `${spacing.xxs}px ${spacing.sm}px`,
                borderRadius: rounded.pill,
                fontFamily: typography['nav-link'].fontFamily,
                fontSize: typography['nav-link'].fontSize,
                fontWeight: typography['nav-link'].fontWeight,
                color: colors.muted,
                cursor: 'pointer',
                border: 0,
                background: 'transparent',
                whiteSpace: 'nowrap',
                transition: 'all 0.2s ease',

                '&:hover': {
                    color: colors.ink,
                    background: colors['surface-soft']
                },

                '&.active': {
                    color: colors.ink,
                    background: colors['surface-card']
                }
            },

            '& .skill-panel-content': {
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: `${spacing.xxs}px var(--extension-gutter) ${spacing.lg}px`
            },

            '& .skill-panel-grid': {
                display: 'grid',
                maxWidth: 'var(--extension-width)',
                marginInline: 'auto',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
                gap: spacing.xs,
                alignItems: 'stretch'
            },

            '& .skill-panel-empty': {
                textAlign: 'center',
                color: colors.muted,
                padding: spacing.xxl
            }
        }
    });
});

export default useStyles;
