import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.compaction-divider': {
            display: 'flex',
            alignItems: 'center',
            gap: spacing.sm,
            padding: `${spacing.xs}px 0`,

            '& .compaction-divider-line': {
                flex: '1 1 0',
                height: 1,
                background: colors.hairline
            },

            '& .compaction-divider-label': {
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacing.xxs,
                flex: '0 0 auto',
                color: colors['muted-soft'],
                fontFamily: typography['body-sm'].fontFamily,
                fontSize: typography['body-sm'].fontSize,
                cursor: 'default'
            }
        }
    });
});

export default useStyles;
