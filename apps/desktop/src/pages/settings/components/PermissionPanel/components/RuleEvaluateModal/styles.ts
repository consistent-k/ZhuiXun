import { spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.rule-evaluate-modal': {
            '& .rule-evaluate-modal-detail': {
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xxs,

                '& code': {
                    fontFamily: typography.code.fontFamily,
                    fontSize: typography['body-sm'].fontSize,
                    wordBreak: 'break-all'
                }
            },

            '& .rule-evaluate-modal-tag': {
                marginLeft: spacing.xs
            }
        }
    });
});

export default useStyles;
