import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.sidebar': {
            width: 'clamp(248px, 21vw, 288px)',
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            background: `color-mix(in srgb, ${colors['surface-soft']} 65%, ${colors.canvas})`,
            borderRight: `1px solid ${colors.hairline}`,

            // 品牌区
            // 自定义顶栏(Electron)：品牌区兼作窗口拖拽区；mac 下 platform-darwin 额外顶部让位，
            // 让浮在左上角的红绿灯有空间、不压住 logo/文字。
            '& .sidebar-brand': {
                padding: `18px 18px 14px`,
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm,
                WebkitAppRegion: 'drag',
                userSelect: 'none'
            },

            // mac 自定义顶栏：顶部让位红绿灯(trafficLightPosition y≈12，按钮高≈14 → 居中到 ~40px 条内)
            '&.platform-darwin .sidebar-brand': {
                paddingTop: 40
            },

            '& .sidebar-brand-mark': {
                width: 28,
                height: 28,
                flex: 'none',
                borderRadius: rounded.lg
            },

            '& .sidebar-brand-text': {
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                overflow: 'hidden'
            },

            '& .sidebar-brand-name': {
                fontSize: typography['title-sm'].fontSize,
                fontWeight: 600,
                color: colors.ink,
                lineHeight: 1.2,
                letterSpacing: '-0.02em'
            },

            '& .sidebar-nav': {
                padding: `${spacing.xxs}px ${spacing.sm}px ${spacing.sm}px`,
                display: 'flex',
                flexDirection: 'column',
                gap: 2
            },

            '& .sidebar-nav-row': {
                width: '100%',
                height: 'auto',
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: spacing.sm,
                minHeight: 32,
                padding: `0 ${spacing.sm}px`,
                border: 'none',
                borderRadius: rounded.md,
                background: 'transparent',
                color: colors['body-strong'],
                fontFamily: 'inherit',
                fontSize: typography.button.fontSize,
                fontWeight: 500,
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'background 0.15s ease, color 0.15s ease',
                '&:hover': {
                    background: colors['surface-card']
                }
            },

            '& .sidebar-nav-row--accent': {
                minHeight: 38,
                justifyContent: 'center',
                gap: spacing.xs,
                marginBottom: spacing.xs,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.lg,
                background: colors.canvas,
                color: colors.ink,
                '& .sidebar-nav-label': { flex: 'none' },
                '&:hover': {
                    background: colors['surface-soft'],
                    borderColor: colors['surface-cream-strong']
                },
                '&:active': {
                    transform: 'translateY(1px)'
                }
            },

            '& .sidebar-nav-row--active': {
                background: colors['surface-card'],
                color: colors.ink,
                '&:hover': {
                    background: colors['surface-card']
                }
            },

            '& .sidebar-nav-icon': {
                flex: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                width: 20,
                color: 'inherit'
            },

            '& .sidebar-nav-label': {
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },

            '& .sidebar-nav-badge': {
                flex: 'none',
                minWidth: 18,
                height: 18,
                padding: '0 5px',
                borderRadius: 9,
                background: colors.primary,
                color: colors['on-primary'],
                fontSize: 10,
                fontWeight: 600,
                lineHeight: '18px',
                textAlign: 'center'
            },

            '& .sidebar-nav-tag': {
                flex: 'none',
                padding: '1px 6px',
                borderRadius: rounded.sm,
                background: colors['surface-card'],
                color: colors.muted,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.5px'
            },

            '& .sidebar-nav-hint': {
                flex: 'none',
                color: colors['muted-soft'],
                fontSize: 12
            },

            // ---- 项目与会话区 ----
            '& .sidebar-section': {
                padding: `0 ${spacing.sm}px ${spacing.xs}px`,
                minHeight: 0,
                flex: 1,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column'
            },

            '& .sidebar-section-header': {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: spacing.xxs,
                padding: `0 ${spacing.xxs}px 0 ${spacing.xs}px`
            },

            '& .sidebar-section-actions': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xxs,
                '& button': {
                    width: 28,
                    height: 28,
                    color: colors.muted
                }
            },

            '& .sidebar-section-title': {
                fontSize: typography['caption-uppercase'].fontSize,
                fontWeight: typography['caption-uppercase'].fontWeight,
                color: colors.muted,
                textTransform: 'uppercase',
                letterSpacing: typography['caption-uppercase'].letterSpacing,
                fontFamily: typography['caption-uppercase'].fontFamily
            },

            '& .sidebar-subsection-title': {
                marginTop: spacing.md,
                marginBottom: spacing.xs,
                padding: `0 ${spacing.xs}px`,
                fontSize: typography['caption-uppercase'].fontSize,
                fontWeight: typography['caption-uppercase'].fontWeight,
                color: colors.muted,
                textTransform: 'uppercase',
                letterSpacing: typography['caption-uppercase'].letterSpacing,
                fontFamily: typography['caption-uppercase'].fontFamily
            },

            '& .sidebar-search': {
                marginBottom: spacing.xs
            },

            '& .sidebar-conversations': {
                flex: 1,
                overflowY: 'auto',
                overflowX: 'hidden',
                scrollbarWidth: 'thin',
                scrollbarColor: 'transparent transparent',
                '&:hover, &:focus-within': { scrollbarColor: `${colors['surface-cream-strong']} transparent` }
            },

            '& .sidebar-groups': {
                // antd 6 使用 collapse-body，清掉面板内边距以对齐项目和会话行。
                '& [class$="-collapse-header"]': {
                    padding: `4px ${spacing.xs}px !important`,
                    minHeight: 32,
                    borderRadius: rounded.md,
                    '&:hover': { background: colors['surface-soft'] },
                    alignItems: 'center !important'
                },
                '& [class$="-collapse-title"]': {
                    minWidth: 0
                },
                '& [class$="-collapse-expand-icon"]': {
                    marginInlineEnd: spacing.xs
                },
                '& [class$="-collapse-body"]': {
                    padding: '0 !important'
                },
                '& [class*="-collapse-item"]': {
                    borderBottom: 'none !important'
                },
                '& [class$="-conversations"]': {
                    padding: 0,
                    gap: 2
                },
                '& [class*="-conversations-item"]:has(.sidebar-conv-label)': {
                    minHeight: 32,
                    height: 32,
                    paddingInline: `28px ${spacing.xs}px`,
                    borderRadius: rounded.md,
                    transition: 'background-color 150ms ease'
                },
                '& [class*="-conversations-item"] > :has(> .sidebar-conv-label)': {
                    alignSelf: 'stretch',
                    fontSize: 13
                }
            },

            '& .sidebar-group-label': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                color: colors.body,
                fontSize: typography.button.fontSize,
                fontWeight: 500,
                overflow: 'hidden'
            },

            // 收件箱图形在 SVG 内的左右留白比文件夹更大，放大绘制尺寸以对齐视觉宽度。
            '& .sidebar-group-inbox-icon > svg': {
                transform: 'scale(1.2)'
            },

            '& .sidebar-group-name': {
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },

            '& .sidebar-group-actions': {
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                gap: spacing.xs,
                paddingLeft: spacing.xs,
                color: colors.muted
            },

            '& .sidebar-group-empty': {
                padding: `${spacing.xxs}px 28px ${spacing.xs}px`,
                color: colors['muted-soft'],
                fontSize: 12
            },

            '& .sidebar-conv-label': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                height: '100%',
                overflow: 'hidden'
            },

            '& .sidebar-conv-title': {
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },

            '& .sidebar-conv-state': {
                flex: 'none',
                color: colors.primary,
                fontSize: 13,
                '&.is-waiting, &.is-stopped': { color: colors.warning },
                '&.is-failed': { color: colors.error }
            },

            '& [class*="-conversations-item-active"]:has([aria-current="true"])': {
                background: `color-mix(in srgb, ${colors.primary} 9%, ${colors['surface-soft']})`,
                '& .sidebar-conv-title': { color: colors.ink, fontWeight: 600 }
            },

            // 日期和省略号共用网格单元，触发器撑满会话行高度，鼠标移入右侧留白也能打开菜单。
            '& .sidebar-conv-meta': {
                flex: 'none',
                alignSelf: 'stretch',
                display: 'inline-grid',
                alignItems: 'center',
                justifyItems: 'end',
                padding: 0,
                border: 0,
                background: 'transparent',
                cursor: 'pointer'
            },

            '& .sidebar-conv-meta > *': {
                gridArea: '1 / 1'
            },

            '& .sidebar-conv-time': {
                color: colors['muted-soft'],
                fontSize: 12,
                lineHeight: 1,
                whiteSpace: 'nowrap',
                transition: 'opacity 0.2s'
            },

            '& .sidebar-conv-menu-icon': {
                color: colors.muted,
                fontSize: 22
            },

            // 菜单展开时鼠标可以移到弹层，行内仍显示省略号。
            '@media (hover: hover)': {
                '& [class*="-conversations-item"]:hover .sidebar-conv-time, & .sidebar-conv-meta:is(:focus-visible, .sidebar-conv-menu-open) .sidebar-conv-time':
                    {
                        opacity: 0
                    },
                '& [class*="-conversations-item"]:not(:hover) .sidebar-conv-meta:not(:focus-visible, .sidebar-conv-menu-open) .sidebar-conv-menu-icon':
                    {
                        opacity: 0
                    }
            },
            '@media (hover: none)': {
                '& .sidebar-conv-meta': { columnGap: spacing.xxs },
                '& .sidebar-conv-menu-icon': { gridColumn: 2 }
            },

            '& .sidebar-footer': {
                padding: spacing.sm
            }
        }
    });
});

export default useStyles;
