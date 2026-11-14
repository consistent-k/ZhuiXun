import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.onboarding-page': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100vh',
            padding: `${spacing.xxl}px ${spacing.lg}px ${spacing.lg}px`,
            background: colors['surface-soft'],
            // 全屏背景作窗口拖拽区（无边框窗口），避开 mac 红绿灯；卡片内标 no-drag 保持可交互
            WebkitAppRegion: 'drag',

            '& .onboarding-page-card': {
                WebkitAppRegion: 'no-drag',
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                maxWidth: 560,
                maxHeight: 'calc(100vh - 80px)',
                padding: spacing.xl,
                background: colors.canvas,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.lg,
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.08)'
            },

            '& .onboarding-page-brand': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xxs,
                marginBottom: spacing.lg
            },

            '& .onboarding-page-logo': {
                fontFamily: typography['display-sm'].fontFamily,
                fontSize: typography['display-sm'].fontSize,
                color: colors.primary
            },

            '& .onboarding-page-brand-sub': {
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            },

            '& .onboarding-page-steps': {
                marginBottom: spacing.lg
            },

            '& .onboarding-page-body': {
                flex: 1,
                minHeight: 0,
                overflowY: 'auto'
            },

            '& .onboarding-page-footer': {
                display: 'flex',
                justifyContent: 'space-between',
                gap: spacing.sm,
                marginTop: spacing.lg,
                paddingTop: spacing.md,
                borderTop: `1px solid ${colors['hairline-soft']}`
            },

            '& .onboarding-step-title': {
                margin: 0,
                marginBottom: spacing.xs,
                fontFamily: typography['title-lg'].fontFamily,
                fontSize: typography['title-lg'].fontSize,
                fontWeight: typography['title-lg'].fontWeight,
                color: colors.ink
            },

            '& .onboarding-step-desc': {
                marginBottom: spacing.lg,
                fontSize: typography['body-sm'].fontSize,
                lineHeight: typography['body-sm'].lineHeight,
                color: colors.muted
            },

            '& .onboarding-welcome-list': {
                margin: 0,
                paddingLeft: spacing.lg,
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xs,
                color: colors.body,
                fontSize: typography['body-md'].fontSize
            },

            '& .onboarding-model-active': {
                marginBottom: spacing.lg
            },

            '& .onboarding-preference-block': {
                marginBottom: spacing.lg,

                '& .onboarding-preference-label': {
                    marginBottom: spacing.xs,
                    fontWeight: 500,
                    color: colors.ink
                }
            },

            '& .onboarding-done': {
                textAlign: 'center',
                padding: `${spacing.lg}px 0`,

                '& .onboarding-done-icon': {
                    fontSize: 48,
                    color: colors.success,
                    marginBottom: spacing.md
                }
            }
        }
    });
});

export default useStyles;
