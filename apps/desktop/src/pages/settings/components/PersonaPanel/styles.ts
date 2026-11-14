import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.persona-panel': {
            '& .persona-panel-header': {
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: spacing.md,
                flexWrap: 'wrap'
            },

            '& .persona-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginTop: spacing.xxs,
                maxWidth: 680
            },

            '& .persona-panel-default': {
                flexWrap: 'wrap',
                border: `1px solid ${colors.hairline}`,
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm,
                marginTop: spacing.lg,
                padding: spacing.md,
                background: colors['surface-soft'],
                borderRadius: rounded.md
            },

            '& .persona-panel-default-label': {
                color: colors.ink,
                fontWeight: 500,
                whiteSpace: 'nowrap'
            },

            '& .persona-panel-default-select': {
                width: 'min(100%, 280px)'
            },

            '& .persona-panel-grid': {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))',
                gap: spacing.md,
                marginTop: spacing.lg
            },

            '& .persona-panel-card': {
                display: 'flex',
                flexDirection: 'column',
                padding: spacing.md,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.lg,
                background: colors.canvas
            },

            '& .persona-panel-card-head': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.xs
            },

            '& .persona-panel-card-name': {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .persona-panel-card-desc': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginTop: spacing.xs
            },

            '& .persona-panel-card-instruction': {
                flex: 1,
                marginTop: spacing.xs,
                marginBottom: spacing.sm,
                color: colors.body,
                fontSize: typography['body-sm'].fontSize
            },

            '& .persona-panel-card-actions': {
                marginTop: 'auto'
            }
        }
    });
});

export default useStyles;
