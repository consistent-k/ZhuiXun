import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.hooks-panel': {
            '& .hooks-panel-row': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md
            },

            '& .hooks-panel-title': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .hooks-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginTop: spacing.xxs
            },

            '& .hooks-panel-path': {
                flexWrap: 'wrap',
                padding: spacing.sm,
                background: colors['surface-soft'],
                borderRadius: rounded.md,
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                marginTop: spacing.md,
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize
            },

            '& .hooks-panel-code': {
                fontFamily: typography.code.fontFamily,
                fontSize: typography['body-sm'].fontSize,
                color: colors['body-strong'],
                wordBreak: 'break-all'
            },

            '& .hooks-panel-alert': {
                marginTop: spacing.sm
            },

            '& .hooks-panel-section': {
                display: 'flex',
                alignItems: 'baseline',
                gap: spacing.sm,
                marginTop: spacing.lg,
                marginBottom: spacing.sm,
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['body-md'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .hooks-panel-meta': {
                marginLeft: spacing.xs,
                color: colors['muted-soft'],
                fontSize: typography.caption.fontSize,
                fontWeight: 400
            },

            '& .hooks-panel-content': {
                margin: 0,
                maxHeight: 320,
                overflow: 'auto',
                padding: spacing.sm,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.md,
                background: colors['surface-soft'],
                fontFamily: typography.code.fontFamily,
                fontSize: typography['body-sm'].fontSize,
                color: colors['body-strong'],
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all'
            }
        }
    });
});

export default useStyles;
