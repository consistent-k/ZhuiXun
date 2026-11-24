import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '@keyframes message-item-blink': {
            '50%': {
                opacity: 0
            }
        },

        // 命令展开内容 Popover 经 portal 渲染在 body 下，不在 .message-item 内，单独挂同一 class 根
        '&.message-item-command-popover .message-item-command-expanded': {
            margin: 0,
            maxWidth: 480,
            maxHeight: 320,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: typography.code.fontFamily,
            fontSize: typography['body-sm'].fontSize,
            color: colors['body-strong']
        },

        // 出错且无任何输出的 assistant 消息：不渲染头像/气泡，只保留停止提示以便重试
        '&.message-item-orphan-notice': {
            maxWidth: '85%'
        },

        '&.message-item': {
            display: 'flex',
            minWidth: 0,

            '&.message-item--user': {
                marginLeft: 'auto',
                maxWidth: '84%',

                // 用户侧气泡与操作条靠右对齐、宽度随内容收缩
                '& .message-item-main': {
                    alignItems: 'flex-end'
                },

                '& .message-item-actions': {
                    justifyContent: 'flex-end'
                }
            },

            '&.message-item--assistant': {
                paddingTop: spacing.xs,

                '& .message-item-main': {
                    flex: 1
                }
            },

            '& .message-item-main': {
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                maxWidth: '100%'
            },

            '& .message-item-author': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                marginBottom: spacing.sm,
                color: colors.ink,
                fontSize: typography['body-sm'].fontSize,
                fontWeight: 600
            },

            '& .message-item-bubble': {
                lineHeight: 1.6,
                fontFamily: typography['body-md'].fontFamily,
                fontSize: typography['body-md'].fontSize,
                minWidth: 0,
                overflowWrap: 'break-word',

                '&.message-item-bubble--user': {
                    padding: `${spacing.sm}px ${spacing.md}px`,
                    borderRadius: rounded.lg,
                    background: colors['surface-soft'],
                    color: colors.ink,
                    whiteSpace: 'pre-wrap'
                },

                '&.message-item-bubble--assistant': {
                    color: colors.body,

                    '& > .stream-md:not(:first-child)': {
                        marginTop: spacing.md
                    },

                    '& > p:last-child': {
                        marginBottom: 0
                    }
                }
            },

            // 操作条（复制/回滚）：常驻占位（高度恒定）使每条消息结构一致，消息间距由此均匀；
            // 不用绝对定位——那会悬浮到下一层消息上。默认透明且不接收点击，悬停本条消息或
            // 内部获焦（Popconfirm 展开）时淡入。放在气泡下方画布背景上，对比度正常。
            '& .message-item-actions': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xxs,
                height: 24,
                marginTop: 8,
                // 抵消一部分占位：24px 高的操作条只让 8px 计入消息高度，其余落在消息间距里
                marginBottom: -spacing.xs,
                opacity: 0,
                pointerEvents: 'none',
                transition: 'opacity 0.15s ease',

                '& .message-item-action-btn': {
                    color: colors.muted,

                    '&:hover': {
                        color: colors.body,
                        background: colors['surface-soft']
                    }
                }
            },

            '&:hover .message-item-actions, &:focus-within .message-item-actions': {
                opacity: 1,
                pointerEvents: 'auto'
            },

            '& .message-item-cursor': {
                display: 'inline-block',
                width: 2,
                height: '1em',
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                background: colors.primary,
                animation: 'message-item-blink 1s steps(2) infinite'
            },

            '& .message-item-command-tag': {
                display: 'inline-flex',
                marginRight: spacing.xs,
                cursor: 'pointer'
            },

            '& .message-item-attachments': {
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacing.xs,
                marginBottom: spacing.xs,

                '& .message-item-image-link': {
                    display: 'inline-flex'
                },

                '& .message-item-image': {
                    maxWidth: 240,
                    maxHeight: 240,
                    borderRadius: rounded.md,
                    objectFit: 'cover'
                },

                '& .message-item-file': {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: spacing.xxs,
                    padding: `${spacing.xxs}px ${spacing.xs}px`,
                    borderRadius: rounded.md,
                    background: colors.canvas,
                    color: colors.body,
                    fontSize: typography.caption.fontSize
                }
            },

            '@media (hover: none)': {
                '& .message-item-actions': {
                    opacity: 1,
                    pointerEvents: 'auto'
                }
            },

            '@media (prefers-reduced-motion: reduce)': {
                '& .message-item-cursor': {
                    animation: 'none'
                }
            }
        }
    });
});

export default useStyles;
