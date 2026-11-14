import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.token-usage-indicator': {
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacing.xs,
            fontFamily: typography.caption.fontFamily,
            fontSize: typography.caption.fontSize,
            color: colors['muted-soft'],
            cursor: 'default',

            '& .token-usage-indicator-text': {
                whiteSpace: 'nowrap'
            },

            '& .token-usage-indicator-progress': {
                width: 96,
                display: 'inline-flex',
                alignItems: 'center'
            },

            '& .token-usage-indicator-percent': {
                whiteSpace: 'nowrap',
                color: colors.muted
            },

            // 上限未知降级态：用 warning 色与占位/加载态区分，避免被误读为「上下文充裕」
            '&.is-degraded': {
                color: colors.warning
            },

            '&.is-loading': {
                color: colors['muted-soft']
            }
        },

        // Popover 明细：纵向行布局
        '&.token-usage-indicator-detail': {
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.xxs,
            minWidth: 140,
            fontSize: typography.caption.fontSize,

            '& .token-usage-indicator-detail-row': {
                display: 'flex',
                justifyContent: 'space-between',
                gap: spacing.md,
                padding: `${spacing.xxs}px 0`
            },

            '& .token-usage-indicator-detail-label': {
                color: colors.muted
            },

            '& .token-usage-indicator-detail-value': {
                color: colors.body,
                fontVariantNumeric: 'tabular-nums'
            },

            '& .token-usage-indicator-detail-sep': {
                borderTop: `1px solid ${colors.hairline}`,
                borderRadius: rounded.xs
            }
        }
    });
});

export default useStyles;
