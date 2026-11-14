import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.agent-guard-panel': {
            '& .agent-guard-panel-field': {
                paddingBlock: spacing.md,
                borderBottom: `1px solid ${colors.hairline}`
            },

            '& .agent-guard-panel-row': {
                padding: spacing.md,
                background: colors['surface-soft'],
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md,
                marginTop: spacing.xl,
                marginBottom: spacing.sm
            },

            '& .agent-guard-panel-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .agent-guard-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginTop: spacing.xxs,
                maxWidth: 560
            },

            '& .agent-guard-panel-save': {
                marginTop: spacing.md
            },

            // 间距放在整组控件上，避免 Compact 中的数字框与单位区域错位。
            '& .agent-guard-panel-control': {
                marginTop: spacing.xs
            },

            '& .agent-guard-panel-input': {
                width: 160
            }
        }
    });
});

export default useStyles;
