import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.project-settings': {
            // 作为 BasicLayout flex 行的内容区：必须 flex:1 + minWidth:0 才能填满侧栏右侧，
            // 否则会收缩到内容最小宽度、把右侧一大片留白（且高度撑破不出滚动条）。
            flex: 1,
            minWidth: 0,
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: colors.canvas,
            overflow: 'hidden',

            '& .project-settings-title': {
                flex: 1,
                fontSize: typography['title-lg']?.fontSize ?? 18,
                fontWeight: 600,
                color: colors.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },

            // 滚动容器：真正的 flex 子项，占满剩余高度并在内容超高时出现滚动条（全宽，滚动条贴窗口右缘）。
            // 注意 Spin 会插一层 nested-loading 包裹，若把滚动放在被 Spin 包住的 body 上，flex 链会被截断，
            // 所以滚动容器必须在 Spin 之外。
            '& .project-settings-scroll': {
                flex: 1,
                minHeight: 0,
                overflowY: 'auto'
            },

            // 内容列：定宽居中，只负责排版，不负责滚动
            '& .project-settings-body': {
                padding: spacing.lg,
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.md,
                maxWidth: 760,
                width: '100%',
                margin: '0 auto'
            },

            '& .project-field': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xs,
                marginBottom: spacing.md,

                '&:last-child': {
                    marginBottom: 0
                },

                '& > label': {
                    fontSize: 13,
                    color: colors.muted
                }
            },

            '& .project-hint': {
                fontSize: 12,
                color: colors['muted-soft']
            },

            '& .project-path-error': {
                marginTop: 4,
                fontSize: 12,
                color: colors.error
            }
        }
    });
});

export default useStyles;
