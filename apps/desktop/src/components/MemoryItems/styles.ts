import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.memory-items': {
            '& .memory-items-toolbar': {
                display: 'flex',
                gap: spacing.sm,
                alignItems: 'center',
                flexWrap: 'wrap'
            },

            '& .memory-items-list': {
                marginTop: spacing.xs
            },

            '& .memory-items-tag': {
                marginLeft: spacing.xs
            },

            '& .memory-items-empty': {
                marginTop: spacing.md
            },

            '& .memory-items-hint': {
                color: colors.muted,
                fontSize: typography['body-sm'].fontSize,
                marginBottom: spacing.sm
            }
        }
    });
});

export default useStyles;
