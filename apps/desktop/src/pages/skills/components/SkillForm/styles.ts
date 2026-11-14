import { spacing } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.skill-form': {
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.sm,

            '& .skill-form-trigger-row': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                marginBottom: spacing.xs
            },

            '& .skill-form-trigger-input': {
                width: 400
            }
        }
    });
});

export default useStyles;
