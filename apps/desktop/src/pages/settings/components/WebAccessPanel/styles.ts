import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.web-access-panel': {
            '& .web-access-rows': {
                display: 'flex',
                flexDirection: 'column'
            },

            '& .web-access-row': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.xl,
                padding: `${spacing.lg}px 0`,
                borderBottom: `1px solid ${colors.hairline}`,

                '&:first-child': {
                    paddingTop: 0
                },

                '&:last-child': {
                    paddingBottom: 0,
                    borderBottom: 'none'
                }
            },

            '& .web-access-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .web-access-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                lineHeight: 1.6,
                marginTop: spacing.xs,

                '&.web-access-hint--block': {
                    marginTop: spacing.md
                }
            },

            '& .web-access-grid': {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))',
                gap: spacing.lg,
                marginTop: spacing.xl
            },

            '& .web-access-columns': {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))',
                gap: spacing.lg,
                marginTop: spacing.lg
            },

            '& .web-access-field': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xs
            },

            '& .web-access-field-label': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize
            },

            '& .web-access-actions': {
                marginTop: spacing.lg
            },

            '& .web-access-test': {
                marginTop: spacing.xxl,
                padding: spacing.md,
                background: colors['surface-soft'],
                borderRadius: 8
            },

            '& .web-access-test-row': {
                display: 'flex',
                gap: spacing.sm,
                flexWrap: 'wrap',
                marginTop: spacing.md
            },

            '& .web-access-test-result': {
                marginTop: spacing.sm,
                fontSize: typography['body-sm'].fontSize,

                '&.web-access-test-result--ok': {
                    color: colors.success
                },

                '&.web-access-test-result--error': {
                    color: colors.error
                }
            }
        }
    });
});

export default useStyles;
