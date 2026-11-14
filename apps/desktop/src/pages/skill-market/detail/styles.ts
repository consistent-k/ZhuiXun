import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.skill-detail-page': {
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            background: colors.canvas,

            '& .skill-detail-crumb': {
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            },

            '& .skill-detail-loading': {
                display: 'flex',
                justifyContent: 'center',
                padding: spacing.xxl
            },

            // 两栏：主内容 + 安装侧栏。整体不滚动，滚动只收敛到 Tab 内容区
            '& .skill-detail-body': {
                flex: 1,
                minHeight: 0,
                overflow: 'hidden',
                display: 'flex',
                gap: spacing.xl,
                maxWidth: 1120,
                width: '100%',
                margin: '0 auto',
                padding: `${spacing.xl}px ${spacing.lg}px ${spacing.xxl}px`,
                alignItems: 'stretch'
            },
            '& .skill-detail-main': {
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column'
            },
            '& .skill-detail-aside': {
                flexShrink: 0,
                width: 280,
                alignSelf: 'flex-start'
            },

            '& .skill-detail-head': {
                display: 'flex',
                gap: spacing.md,
                marginBottom: spacing.md,
                flexShrink: 0
            },
            '& .skill-detail-icon': {
                flexShrink: 0,
                borderRadius: rounded.md,
                background: colors['surface-card'],
                color: colors.ink
            },
            '& .skill-detail-headinfo': {
                minWidth: 0
            },
            '& .skill-detail-name': {
                margin: 0,
                fontFamily: typography['display-sm'].fontFamily,
                fontSize: typography['display-sm'].fontSize,
                fontWeight: 600,
                color: colors.ink
            },
            '& .skill-detail-canonical': {
                fontFamily: typography.code.fontFamily,
                fontSize: typography.caption.fontSize,
                color: colors['muted-soft'],
                marginTop: 2
            },
            '& .skill-detail-tags': {
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacing.xxs,
                marginTop: spacing.xs
            },
            '& .skill-detail-desc': {
                fontSize: typography['body-md'].fontSize,
                color: colors.body,
                marginBottom: spacing.md
            },

            // Tabs 填满主栏剩余高度，滚动条只落在 Tab 内容区（prefixCls=zhuixun，antd6 内容容器类名为 *-tabs-body-holder）
            '& .skill-detail-tabs': {
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column'
            },
            '& .skill-detail-tabs [class*="-tabs-body-holder"]': {
                flex: 1,
                minHeight: 0,
                overflowY: 'auto'
            },
            '& .skill-detail-changelog': {
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            },
            '& .skill-detail-scan': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                marginBottom: spacing.xs,
                fontSize: typography['body-sm'].fontSize,
                color: colors.body
            },

            '& .skill-detail-install-card': {
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.lg,
                background: colors['surface-soft'],
                padding: spacing.md,
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.sm
            },
            '& .skill-detail-stats': {
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacing.md,
                fontSize: typography.caption.fontSize,
                color: colors.muted
            }
        }
    });
});

export default useStyles;
