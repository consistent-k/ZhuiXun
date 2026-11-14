import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.log-panel': {
            '& .log-panel-toolbar': {
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.sm,
                marginBottom: spacing.md
            },

            '& .log-panel-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginLeft: 'auto',
                whiteSpace: 'nowrap'
            },

            '& .log-panel-list': {
                display: 'flex',
                flexDirection: 'column',
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.md,
                background: colors['surface-soft'],
                // 日志沿用设置内容区滚动，避免同一列出现嵌套滚动条。
                fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
                fontSize: typography['body-sm'].fontSize
            },

            '& .log-panel-item': {
                display: 'flex',
                gap: spacing.sm,
                padding: `${spacing.xxs}px ${spacing.sm}px`,
                borderBottom: `1px solid ${colors.hairline}`,
                alignItems: 'baseline',
                flexWrap: 'wrap',
                '&:last-child': { borderBottom: 0 }
            },

            '& .log-panel-time': {
                color: colors['muted-soft'],
                flex: '0 0 auto'
            },

            '& .log-panel-module': {
                color: colors.muted,
                flex: '0 0 auto'
            },

            '& .log-panel-msg': {
                color: colors['body-strong'],
                minWidth: 0,
                overflowWrap: 'anywhere',
                whiteSpace: 'pre-wrap'
            },

            '& .log-panel-fields': {
                color: colors['muted-soft'],
                borderRadius: rounded.md
            }
        }
    });
});

export default useStyles;
