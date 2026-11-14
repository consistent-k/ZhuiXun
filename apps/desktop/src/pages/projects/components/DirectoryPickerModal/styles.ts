import { colors, spacing, rounded } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.dir-picker': {
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.sm,

            '& .dir-picker-toolbar': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm
            },

            '& .dir-picker-current': {
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12,
                color: colors.muted
            },

            '& .dir-picker-list': {
                height: 320,
                overflowY: 'auto',
                border: `1px solid ${colors.hairline}`,
                borderRadius: rounded.sm,
                padding: spacing.xs
            },

            '& .dir-picker-item': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                padding: `${spacing.xs}px ${spacing.sm}px`,
                borderRadius: rounded.sm,
                cursor: 'pointer',
                color: colors.body,

                '&:hover': {
                    background: colors['surface-soft']
                }
            },

            '& .dir-picker-item-name': {
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            },

            '& .dir-picker-footer': {
                display: 'flex',
                justifyContent: 'flex-end',
                gap: spacing.sm
            }
        }
    });
});

export default useStyles;
