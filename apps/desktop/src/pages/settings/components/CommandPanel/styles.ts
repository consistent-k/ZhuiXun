import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.command-panel': {
            '& .command-panel-toolbar': {
                flexWrap: 'wrap',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md,
                marginBottom: spacing.sm
            },

            '& .command-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize
            },

            '& .command-panel-name': {
                fontFamily: typography.code.fontFamily,
                fontSize: typography['body-sm'].fontSize,
                color: colors['body-strong']
            },

            '& .command-panel-meta': {
                marginLeft: spacing.xs,
                color: colors['muted-soft'],
                fontSize: typography.caption.fontSize
            },

            '& .command-panel-section': {
                paddingTop: spacing.sm,
                borderTop: `1px solid ${colors.hairline}`,
                marginTop: spacing.lg,
                marginBottom: spacing.sm,
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['body-md'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            }
        },

        // 编辑弹窗经 portal 渲染在 body 下，单独挂同一 class 根
        '&.command-panel-modal': {
            '& .command-panel-body': {
                fontFamily: typography.code.fontFamily,
                fontSize: typography['body-sm'].fontSize
            }
        }
    });
});

export default useStyles;
