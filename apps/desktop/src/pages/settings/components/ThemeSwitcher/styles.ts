import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.theme-switcher': {
            display: 'grid',
            // 按容器宽度自适应列数：每列至少 160px，剩余空间等分，窄则自动换行
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 160px), 1fr))',
            gap: spacing.md,

            '& .theme-switcher-card': {
                position: 'relative',
                minWidth: 0,
                padding: spacing.sm,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.lg,
                background: colors.canvas,
                cursor: 'pointer',
                transition: 'border-color 0.2s, box-shadow 0.2s',

                '&:hover': {
                    borderColor: colors['primary-active']
                },

                '&.is-active': {
                    borderColor: colors.primary,
                    boxShadow: `0 0 0 1px ${colors.primary}`
                }
            },

            '& .theme-switcher-preview': {
                display: 'flex',
                height: 36,
                borderRadius: rounded.md,
                overflow: 'hidden',
                border: `1px solid ${colors['hairline-soft']}`
            },

            '& .theme-switcher-swatch': {
                flex: 1
            },

            '& .theme-switcher-meta': {
                marginTop: spacing.xs,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.xs
            },

            '& .theme-switcher-name': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .theme-switcher-check': {
                color: colors.primary,
                fontSize: 18
            },

            '& .theme-switcher-desc': {
                marginTop: spacing.xxs,
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            }
        }
    });
});

export default useStyles;
