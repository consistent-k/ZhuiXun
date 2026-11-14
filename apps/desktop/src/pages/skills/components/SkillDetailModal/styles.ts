import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.skill-detail-modal': {
            '& .skill-detail-modal-actions': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                flexWrap: 'wrap',
                gap: spacing.xs,
                '& [role="switch"]': { marginInlineEnd: 'auto' }
            },

            '& .skill-detail-modal-description': {
                margin: '0 !important',
                fontFamily: typography['body-md'].fontFamily,
                fontSize: typography['body-md'].fontSize,
                color: colors.body
            },

            '& .skill-detail-modal-section': {
                marginTop: spacing.lg
            },

            '& .skill-detail-modal-section-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink,
                marginBottom: spacing.sm
            },

            '& .skill-detail-modal-info-grid': {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))',
                padding: spacing.sm,
                borderRadius: rounded.md,
                background: colors['surface-soft'],
                gap: `${spacing.sm}px ${spacing.lg}px`
            },

            '& .skill-detail-modal-info-row': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs
            },

            '& .skill-detail-modal-info-label': {
                fontSize: typography['body-sm'].fontSize,
                color: colors['muted-soft']
            },

            '& .skill-detail-modal-info-value': {
                fontSize: typography['body-sm'].fontSize,
                color: colors.body,
                overflowWrap: 'anywhere'
            },

            '& .skill-detail-modal-tool-list': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.sm
            },

            '& .skill-detail-modal-tool-item': {
                padding: spacing.sm,
                background: colors['surface-soft'],
                borderRadius: rounded.sm,
                border: `1px solid ${colors.hairline}`
            },

            '& .skill-detail-modal-tool-name': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.primary,
                marginBottom: spacing.xxs
            },

            '& .skill-detail-modal-tool-description': {
                fontFamily: typography['body-sm'].fontFamily,
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            }
        }
    });
});

export default useStyles;
