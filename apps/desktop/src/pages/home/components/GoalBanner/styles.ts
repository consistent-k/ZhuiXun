import { colors, spacing } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.goal-banner': {
            display: 'flex',
            alignItems: 'center',
            gap: spacing.sm,
            padding: `${spacing.xs} ${spacing.lg}`,
            borderTop: `1px solid ${colors.hairline}`,
            background: colors.canvas,
            flexShrink: 0
        },

        '& .goal-banner-tag': {
            marginInlineEnd: 0,
            flexShrink: 0
        },

        '& .goal-banner-text': {
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
            color: colors.muted
        },

        '& .goal-banner-stop': {
            flexShrink: 0
        }
    });
});

export default useStyles;
