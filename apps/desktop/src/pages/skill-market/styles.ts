import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.skill-market-page': {
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            background: colors.canvas,

            '& .skill-market-topbar-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            // body 作 flex 列容器本身不滚动：顶部 sticky 区固定，仅下方 scroll 区滚动
            '& .skill-market-body': {
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
            },
            // 固定区：标题 + 过滤条件 + 搜索框，不随列表滚动
            '& .skill-market-sticky': {
                flexShrink: 0,
                paddingTop: spacing.xl
            },
            // 滚动区：撑满剩余高度、整列表在此滚动；滚动条贴窗口右缘
            '& .skill-market-scroll': {
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                paddingBottom: spacing.xxl
            },
            '& .skill-market-heading': {
                maxWidth: 1120,
                margin: '0 auto',
                padding: `0 ${spacing.lg}px`,
                display: 'flex',
                alignItems: 'baseline',
                gap: spacing.md,
                flexWrap: 'wrap'
            },
            '& .skill-market-h1': {
                margin: 0,
                fontFamily: typography['display-sm'].fontFamily,
                fontSize: typography['display-sm'].fontSize,
                fontWeight: 600,
                color: colors.ink
            },
            '& .skill-market-sub': {
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            },

            '& .skill-market-toolbar': {
                maxWidth: 1120,
                margin: `${spacing.lg}px auto 0`,
                padding: `0 ${spacing.lg}px`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md,
                flexWrap: 'wrap'
            },
            '& .skill-market-filters': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm,
                flexWrap: 'wrap'
            },

            // 外层容器负责限宽/间距；不要把 display/padding 直接压到 Input.Search 根上，
            // 否则会把它的 space-compact(inline-flex) 布局改成 block，搜索按钮被挤到下一行。
            '& .skill-market-search-wrap': {
                maxWidth: 1120,
                margin: `${spacing.md}px auto 0`,
                padding: `0 ${spacing.lg}px`
            },

            '& .skill-market-content': {
                maxWidth: 1120,
                margin: `${spacing.md}px auto 0`,
                padding: `0 ${spacing.lg}px`
            },
            '& .skill-market-loading': {
                display: 'flex',
                justifyContent: 'center',
                padding: spacing.xl
            },

            // 竖排列表（参考页为单列列表，而非卡片网格）
            '& .skill-market-list': {
                display: 'flex',
                flexDirection: 'column'
            },
            '& .market-row': {
                display: 'flex',
                alignItems: 'flex-start',
                gap: spacing.md,
                padding: `${spacing.md}px ${spacing.xs}px`,
                borderBottom: `1px solid ${colors['hairline-soft']}`,
                cursor: 'pointer',
                transition: 'background 0.15s',
                '&:hover': { background: colors['surface-soft'] }
            },
            '& .market-row-icon': {
                flexShrink: 0,
                borderRadius: rounded.md,
                background: colors['surface-card'],
                color: colors.ink
            },
            '& .market-row-main': {
                flex: 1,
                minWidth: 0
            },
            '& .market-row-title': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                flexWrap: 'wrap',
                marginBottom: spacing.xxs
            },
            '& .market-row-name': {
                fontWeight: 600,
                color: colors.ink,
                maxWidth: 420,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },
            '& .market-row-desc': {
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },
            '& .market-row-meta': {
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: spacing.md,
                fontSize: typography.caption.fontSize,
                color: colors['muted-soft']
            },
            '& .market-row-stat': {
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacing.xxs,
                minWidth: 56,
                justifyContent: 'flex-end'
            },
            '& .market-row-owner': {
                color: colors.muted,
                maxWidth: 120,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },

            '& .skill-market-more': {
                display: 'flex',
                justifyContent: 'center',
                padding: spacing.lg
            },

            // 网格视图
            '& .skill-market-grid': {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: spacing.md
            },
            '& .market-grid-card': {
                '& .market-grid-head': {
                    display: 'flex',
                    alignItems: 'center',
                    gap: spacing.xs,
                    marginBottom: spacing.xs
                },
                '& .market-grid-icon': {
                    flexShrink: 0,
                    borderRadius: rounded.sm,
                    background: colors['surface-card'],
                    color: colors.ink
                },
                '& .market-grid-name': {
                    fontWeight: 600,
                    color: colors.ink,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                },
                '& .market-grid-tags': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: spacing.xxs,
                    marginBottom: spacing.xs
                },
                '& .market-grid-desc': {
                    fontSize: typography['body-sm'].fontSize,
                    color: colors.muted,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    // 多行省略依赖此属性与 -webkit-line-clamp 配合，MDN 明确该组合仍受支持。
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    minHeight: 40,
                    marginBottom: spacing.sm
                },
                '& .market-grid-foot': {
                    display: 'flex',
                    alignItems: 'center',
                    gap: spacing.md,
                    fontSize: typography.caption.fontSize,
                    color: colors['muted-soft']
                },
                '& .market-grid-stat': {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: spacing.xxs
                }
            }
        }
    });
});

export default useStyles;
