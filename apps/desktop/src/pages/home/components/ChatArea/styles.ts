import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.chat-area': {
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: colors.canvas,
            minWidth: 0,
            // 内嵌分栏中允许聊天区收缩，让长消息在列表内滚动。
            minHeight: 0,
            '--chat-column-width': '760px',
            '--chat-gutter': 'clamp(16px, 2vw, 24px)',

            '& > .zhuixun-page-header': {
                minHeight: 56,
                borderBottomColor: colors.hairline
            },

            '&:has(.message-list-placeholder) .chat-transcript-inner': {
                justifyContent: 'safe center'
            },

            '& .chat-area-workspace': {
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
                minWidth: 0
            },

            '& .chat-area-composer': {
                flexShrink: 0,
                minWidth: 0
            },

            '@media (min-width: 1460px)': {
                '& .chat-area-workspace:has(> .approval-dock--question)': {
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 360px',
                    gridTemplateRows: 'minmax(0, 1fr) auto',
                    '--chat-gutter': '24px',

                    '& > .approval-dock': {
                        gridColumn: 2,
                        gridRow: '1 / 3',
                        maxHeight: 'none',
                        padding: spacing.md,
                        borderLeft: `1px solid ${colors.hairline}`,
                        background: colors['surface-soft']
                    },

                    '& > .chat-area-composer': {
                        gridColumn: 1,
                        gridRow: 2
                    }
                }
            },

            '& .chat-area-title': {
                minWidth: 0,
                flex: '0 1 auto',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: typography['title-md'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: 600,
                color: colors.ink
            },

            // 右侧操作区：风格 + 归属靠右排列
            '& .chat-area-actions': {
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                flex: 'none'
            },

            '& .chat-area-persona, & .chat-area-project': {
                display: 'flex',
                alignItems: 'center',
                paddingInlineStart: spacing.xs,
                minWidth: 0,
                color: colors.muted,
                borderRadius: rounded.md,
                '&:hover, &:focus-within': { background: colors['surface-soft'] },
                '& [class$="-select"]': { maxWidth: 144, fontSize: 13 }
            },

            '& .chat-area-alert': {
                margin: `${spacing.sm}px ${spacing.lg}px 0`
            }
        }
    });
});

export default useStyles;
