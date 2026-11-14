import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.remembered-rules': {
            '& .remembered-rules-row': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md,
                padding: spacing.md,
                background: colors['surface-soft'],
                borderRadius: rounded.md
            },

            '& .remembered-rules-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .remembered-rules-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginTop: spacing.xxs
            },

            '& .remembered-rules-list-header': {
                marginTop: spacing.lg,
                marginBottom: spacing.sm,
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['body-md'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink,

                '& .remembered-rules-hint': {
                    fontWeight: 400
                }
            },

            '& .remembered-rules-list': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xs
            },

            '& .remembered-rules-item': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md,
                flexWrap: 'wrap',
                padding: `${spacing.sm}px ${spacing.md}px`,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.md,
                background: colors.canvas
            },

            '& .remembered-rules-item-main': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                minWidth: 0
            },

            '& .remembered-rules-item-head': {
                fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
                fontSize: typography['body-sm'].fontSize,
                color: colors['body-strong'],
                wordBreak: 'break-all'
            },

            '& .remembered-rules-item-tag': {
                flex: '0 0 auto'
            },

            '& .remembered-rules-item-meta': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm,
                flex: '0 0 auto'
            },

            '& .remembered-rules-item-time': {
                fontSize: typography.caption.fontSize,
                color: colors['muted-soft']
            }
        }
    });
});

export default useStyles;
