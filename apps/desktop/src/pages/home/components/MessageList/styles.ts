import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.message-list': {
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.lg
        },

        '&.message-list-placeholder': {
            paddingBlock: spacing.lg,
            '& h1': {
                fontFamily: typography['title-md'].fontFamily,
                fontSize: 'clamp(26px, 3vw, 36px)',
                fontWeight: 600,
                letterSpacing: '-0.025em',
                lineHeight: 1.18,
                color: colors.ink
            },
            '& p': {
                marginTop: spacing.sm,
                fontSize: typography['body-sm'].fontSize,
                color: colors.muted
            }
        }
    });
});

export default useStyles;
