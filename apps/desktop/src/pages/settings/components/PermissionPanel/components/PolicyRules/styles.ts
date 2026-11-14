import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.policy-rules': {
            '& .policy-rules-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                overflowWrap: 'anywhere'
            },

            '& .policy-rules-alert': {
                marginTop: spacing.sm
            },

            '& .policy-rules-toolbar': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.sm,
                flexWrap: 'wrap',
                margin: `${spacing.md}px 0 ${spacing.sm}px`
            },

            '& .policy-rules-actions': {
                display: 'flex',
                gap: spacing.xs,
                flex: '0 0 auto'
            },

            '& .policy-rules-code': {
                fontFamily: typography.code.fontFamily,
                fontSize: typography['body-sm'].fontSize,
                color: colors['body-strong'],
                wordBreak: 'break-all'
            },

            '& .policy-rules-readonly': {
                color: colors['muted-soft'],
                fontSize: typography.caption.fontSize
            }
        },

        // 新增弹窗经 portal 渲染在 body 下，不在 .policy-rules 内，单独挂同一 class 根
        '&.policy-rules-modal': {
            '& .policy-rules-examples': {
                margin: `${spacing.xxs}px 0 0`,
                paddingLeft: spacing.md,
                color: colors.muted,
                fontSize: typography.caption.fontSize
            }
        }
    });
});

export default useStyles;
