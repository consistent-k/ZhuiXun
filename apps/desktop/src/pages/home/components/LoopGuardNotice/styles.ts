import { spacing } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.loop-guard-notice': {
            marginTop: spacing.xs
        }
    });
});

export default useStyles;
