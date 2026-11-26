import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.reply-error': {
            marginTop: spacing.xs,
            color: colors.muted,
            fontSize: typography['body-sm'].fontSize,
            '& .reply-error-row': { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
            '& .reply-error-details': {
                marginTop: spacing.xs,
                '& summary': { cursor: 'pointer', width: 'fit-content', '&:hover': { color: colors.ink } },
                '& pre': {
                    margin: `${spacing.xs}px 0 0`,
                    padding: spacing.sm,
                    borderLeft: `2px solid ${colors.hairline}`,
                    fontFamily: typography.code.fontFamily,
                    fontSize: 12,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    maxHeight: 160,
                    overflowY: 'auto'
                }
            }
        },
        '&.loop-guard-notice': {
            marginTop: spacing.xs
        }
    });
});

export default useStyles;
