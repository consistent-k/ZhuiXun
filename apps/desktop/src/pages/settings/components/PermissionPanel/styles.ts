import { spacing } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.permission-panel': {
            '& [class$="-tabs-nav"]': {
                marginBottom: spacing.lg
            }
        }
    });
});

export default useStyles;
