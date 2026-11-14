import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const attachmentSize = 28;
const primaryActionSize = 34;

const useStyles = createStyles(({ css }) => {
    return css({
        '&.input-box': {
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.xxs,
            width: '100%',
            maxWidth: 'calc(var(--chat-column-width) + 2 * var(--chat-gutter))',
            marginInline: 'auto',
            padding: `${spacing.sm}px var(--chat-gutter) ${spacing.sm}px`,

            '& .input-box-composer': {
                background: colors.canvas,
                border: `1px solid ${colors['surface-cream-strong']}`,
                borderRadius: rounded.xl,
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
                '&:focus-within': {
                    borderColor: colors.primary
                }
            },

            '& .input-box-editor': {
                padding: `${spacing.sm}px ${spacing.sm}px ${spacing.xxs}px`
            },

            // Sender 的 footer 自带内边距，统一在这一层设置，避免和工具栏叠加。
            '& .input-box-composer .input-box-footer': {
                padding: `0 ${spacing.xs}px ${spacing.xs}px ${spacing.xxs}px`
            },

            '& .input-box-toolbar': {
                display: 'flex',
                alignItems: 'flex-end',
                gap: spacing.xs,

                '& .input-box-toolbar-leading': {
                    display: 'flex',
                    alignItems: 'center',
                    gap: spacing.xs
                },

                '& .input-box-attach-button': {
                    width: attachmentSize,
                    minWidth: attachmentSize,
                    height: attachmentSize,
                    padding: 0
                },

                '& .input-box-primary-actions': {
                    display: 'flex',
                    marginInlineStart: 'auto',
                    '& button': { width: primaryActionSize, minWidth: primaryActionSize, height: primaryActionSize }
                }
            },

            '& .input-box-shortcuts': {
                color: colors.muted,
                fontSize: 12
            },

            // 拖拽文件悬停：整条输入区描边高亮
            '&.is-dragover': {
                outline: `2px dashed ${colors.primary}`,
                outlineOffset: -4
            },

            '& .input-box-attachments': {
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacing.xs
            },

            '& .input-box-attachment': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                maxWidth: 220,
                padding: `${spacing.xxs}px ${spacing.xs}px`,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.md,
                background: colors['surface-soft'],
                fontSize: typography.caption.fontSize,
                color: colors.body,

                '&.is-error': {
                    borderColor: colors.error,
                    color: colors.error
                },

                '& .input-box-attachment-icon': {
                    color: colors.muted
                },

                '& .input-box-attachment-thumb': {
                    width: 28,
                    height: 28,
                    objectFit: 'cover',
                    borderRadius: rounded.xs
                },

                '& .input-box-attachment-name': {
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                },

                '& .input-box-attachment-remove': {
                    marginLeft: 'auto',
                    color: colors['muted-soft'],
                    cursor: 'pointer',
                    '&:hover': {
                        color: colors.body
                    }
                }
            },

            '& .input-box-hint': {
                display: 'flex',
                alignItems: 'center',
                // 用量在首轮回复后才出现，始终预留一行，避免输入框随用量显示上移。
                blockSize: 20,
                fontSize: 12,
                color: colors.muted,
                fontFamily: typography.caption.fontFamily,

                '& .input-box-hint-usage': {
                    marginLeft: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center'
                }
            }
        }
    });
});

export default useStyles;
