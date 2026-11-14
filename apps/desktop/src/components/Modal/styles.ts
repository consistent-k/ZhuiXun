import { colors, spacing } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) =>
    css({
        '& [class$="-form-item"]': {
            marginBottom: spacing.md
        },

        '& form > [class$="-form-item"]:last-child': {
            marginBottom: 0
        },

        '& [class$="-form-item-label"] > label': {
            fontSize: 14,
            fontWeight: 500
        },

        '& [class$="-form-item-extra"]': {
            minHeight: 0,
            marginTop: spacing.xxs,
            color: colors.muted,
            fontSize: 12
        },

        '& .modal-form-grid': {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
            columnGap: spacing.md
        },

        '& .modal-form-section': {
            paddingTop: spacing.md,
            borderTop: `1px solid ${colors.hairline}`,
            '& > h3': {
                marginBottom: spacing.sm,
                color: colors.ink,
                fontSize: 14,
                fontWeight: 600
            },
            '& > [class$="-form-item"]:last-child': {
                marginBottom: 0
            }
        }
    })
);

export default useStyles;
