import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.settings-page': {
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            background: colors.canvas,

            '& .settings-page-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: 600,
                color: colors.ink
            },

            '& .settings-page-content': {
                display: 'flex',
                flex: 1,
                overflow: 'hidden'
            },

            '& .settings-page-tab-nav': {
                width: 168,
                minWidth: 148,
                flex: 'none',
                background: colors.canvas,
                paddingTop: spacing.xs,
                paddingBottom: spacing.md,
                overflowY: 'auto',
                paddingInline: spacing.xs,
                scrollbarWidth: 'thin',
                borderInlineEnd: `1px solid ${colors.hairline}`,
                '& [class$="-menu-item-group-title"]': {
                    color: colors.muted,
                    fontSize: 12,
                    padding: '10px 12px 2px'
                },
                '&.settings-page-tab-nav [class*="-menu-item"][role="menuitem"]': {
                    height: 32,
                    lineHeight: '32px',
                    fontSize: 13,
                    marginBlock: 2,
                    paddingInlineEnd: spacing.xs,
                    '& [class$="-menu-title-content"]': { marginInlineStart: spacing.xs },
                    borderRadius: rounded.md
                },
                '&.settings-page-tab-nav [class*="-menu-item-selected"][role="menuitem"]': {
                    background: colors['surface-card'],
                    color: colors.ink,
                    fontWeight: 600
                }
            },

            '& .settings-page-main-panel': {
                flex: 1,
                minWidth: 0,
                overflowY: 'auto',
                padding: `clamp(20px, 3vw, 36px)`
            },

            '& .settings-page-section': {
                width: '100%',
                maxWidth: 820,
                marginInline: 'auto',
                fontSize: 14,
                '& > h1': {
                    marginBottom: spacing.lg,
                    paddingBottom: spacing.sm,
                    borderBottom: `1px solid ${colors.hairline}`,
                    fontSize: 22,
                    fontWeight: 600,
                    color: colors.ink
                },
                '& [class$="-table-wrapper"]': {
                    border: `1px solid ${colors.hairline}`,
                    borderRadius: rounded.md
                },
                '& [class$="-table-thead"] > tr > th': {
                    background: colors['surface-soft'],
                    color: colors.muted,
                    fontWeight: 500,
                    fontSize: 12
                },
                '& [class$="-card"], & [class$="-alert"]': {
                    borderRadius: rounded.md
                }
            },

            '& .settings-page-preference': {
                paddingBlock: spacing.md,
                borderTop: `1px solid ${colors.hairline}`
            },

            '& .settings-page-preference-label': {
                marginBottom: spacing.xs,
                fontWeight: 600,
                color: colors.ink
            },

            '& .settings-page-toolbar': {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.sm,
                marginBottom: spacing.lg
            },

            '& .settings-page-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize
            },

            '& .settings-page-model-panel': {
                maxWidth: 480
            },

            '& .settings-page-app-panel': {
                maxWidth: 720
            },

            '& .settings-page-provider-panel': {
                maxWidth: 720
            },

            '& .settings-page-empty, & .settings-page-recycle-list': {
                marginInline: 0,
                padding: spacing.md,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.lg,
                background: colors['surface-soft']
            },

            '& .settings-page-active-row': {
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.sm,
                marginBottom: spacing.lg,
                padding: spacing.md,
                background: colors['surface-soft'],
                borderRadius: rounded.md
            },

            '& .settings-page-active-label': {
                color: colors.ink,
                fontWeight: 500,
                whiteSpace: 'nowrap'
            },

            '& .settings-page-active-select': {
                flex: 1,
                minWidth: 'min(100%, 200px)'
            },

            '& .settings-page-model-tags': {
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacing.xxs
            },

            '& .settings-page-memory-panel': {
                maxWidth: 960
            },

            '& .settings-page-server-card': {
                marginBottom: spacing.md,
                borderRadius: rounded.md
            },

            '& .settings-page-card-header': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: spacing.xs
            },

            '& .settings-page-card-title': {
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.xs,
                minWidth: 0,
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink
            },

            '& .settings-page-card-meta': {
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.sm,
                marginTop: spacing.xs,
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                wordBreak: 'break-all'
            },

            '& .settings-page-error': {
                color: colors.error
            },

            '& .settings-page-tool-badge': {
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacing.xxs,
                padding: `${spacing.xxs}px ${spacing.xs}px`,
                background: colors['surface-soft'],
                borderRadius: rounded.xs,
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            }
        }
    });
});

export default useStyles;
