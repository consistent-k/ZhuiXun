import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.automations-page': {
            flex: 1,
            minWidth: 0,
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: colors.canvas,
            overflow: 'hidden',

            '& .automations-title': {
                flex: 1,
                fontSize: typography['title-lg']?.fontSize ?? 18,
                fontWeight: 600,
                color: colors.ink
            },

            // 表头下方的内容区：作为运行历史抽屉（getContainer={false}）的定位容器，
            // 让抽屉从表头下方展开，避开表头的窗口拖拽区。
            '& .automations-content': {
                position: 'relative',
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
            },

            // 滚动容器在 header 之外，占满剩余高度
            '& .automations-scroll': {
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: spacing.lg
            },

            '& .automations-toolbar': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm,
                marginBottom: spacing.md
            },

            // 失败原因行内呈现：红色、可换行
            '& .automation-last-error': {
                marginTop: 4,
                fontSize: 12,
                color: colors.error,
                wordBreak: 'break-all'
            },

            '& .automation-sub': {
                fontSize: 12,
                color: colors.muted
            }
        }
    });
});

export default useStyles;
