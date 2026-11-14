import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.ask-question-card': {
            containerType: 'inline-size',
            border: `1px solid ${colors.primary}`,
            borderRadius: rounded.md,
            background: colors['surface-soft'],
            padding: spacing.sm,
            marginBottom: spacing.sm,
            minWidth: 0,
            fontSize: typography['body-sm'].fontSize,
            color: colors.body,

            '& .ask-question-card-header': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                marginBottom: spacing.sm,
                color: colors.primary,
                fontSize: typography.caption.fontSize
            },
            '& .ask-question-card-navigation': {
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacing.xs,
                marginBottom: spacing.md,
                '& .ant-btn': { maxWidth: '100%', whiteSpace: 'normal', height: 'auto', minHeight: 24 }
            },
            '& .ask-question-card-question': {
                color: colors.ink,
                fontWeight: 500,
                marginBottom: spacing.xs,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere'
            },
            '& .ask-question-card-mode': { marginBottom: spacing.sm },
            '& .ask-question-card-choice-layout': {
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                alignItems: 'start',
                gap: spacing.sm
            },
            '& .ask-question-card-controls': { minWidth: 0 },
            '& .ask-question-card-options': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xs,
                width: '100%'
            },
            '& .ask-question-card-option': {
                display: 'flex',
                alignItems: 'flex-start',
                marginInline: 0,
                textAlign: 'left',
                whiteSpace: 'normal',
                height: 'auto',
                padding: spacing.xs,
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.sm,
                background: colors['surface-card'],
                '&.ant-radio-wrapper-checked, &.ant-checkbox-wrapper-checked': {
                    borderColor: colors.primary,
                    background: colors['surface-cream-strong']
                },
                '&:focus-within': { outline: `2px solid ${colors.primary}`, outlineOffset: 2 },
                '& .ant-radio, & .ant-checkbox': { marginTop: 3 },
                '& > span:last-child': { minWidth: 0, flex: 1 }
            },
            '& .ask-question-card-option-content': { display: 'flex', flexDirection: 'column', gap: spacing.xxs },
            '& .ask-question-card-option-label': { fontWeight: 500, overflowWrap: 'anywhere' },
            '& .ask-question-card-option-description': {
                color: colors.muted,
                fontSize: typography.caption.fontSize,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere'
            },
            '& .ask-question-card-custom-input': { marginTop: spacing.xs },
            '& .ask-question-card-preview': {
                minWidth: 0,
                maxHeight: 340,
                overflow: 'auto',
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.sm,
                background: colors['surface-card'],
                padding: spacing.sm,
                overflowWrap: 'anywhere',
                '& pre': { maxWidth: '100%', overflowX: 'auto' }
            },
            '& .ask-question-card-preview-title': {
                color: colors.muted,
                fontSize: typography.caption.fontSize,
                marginBottom: spacing.xs
            },
            '& .ask-question-card-selected': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                color: colors.success
            },
            '& .ask-question-card-hint': { color: colors.muted, fontSize: typography.caption.fontSize },
            '& .ask-question-card-footer': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: spacing.xs
            },
            '& .ask-question-card-actions': { display: 'flex', flexWrap: 'wrap', gap: spacing.xs },
            '& .ask-question-card-summary': { display: 'flex', flexDirection: 'column', gap: spacing.sm },
            '& .ask-question-card-summary-question': {
                paddingTop: spacing.xs,
                borderTop: `1px solid ${colors['hairline-soft']}`
            },
            '& .ask-question-card-summary-options': {
                marginBlock: spacing.xs,
                paddingInlineStart: spacing.lg,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere'
            },
            '& .ask-question-card-custom-summary': {
                borderLeft: `2px solid ${colors.hairline}`,
                paddingLeft: spacing.sm,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere'
            },
            '& .ant-alert': { marginTop: spacing.sm },
            '@container (max-width: 520px)': {
                '& .ask-question-card-choice-layout': { gridTemplateColumns: 'minmax(0, 1fr)' }
            }
        }
    });
});

export default useStyles;
