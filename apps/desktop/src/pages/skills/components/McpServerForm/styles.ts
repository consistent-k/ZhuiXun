import { spacing } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.mcp-server-form': {
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.md,

            '& .mcp-server-form-arg-row': {
                display: 'flex',
                marginBottom: 4
            },

            '& .mcp-server-form-arg-input': {
                width: 400
            },

            '& .mcp-server-form-env-row': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs
            },

            '& .mcp-server-form-env-key': {
                flex: 1
            },

            '& .mcp-server-form-env-value': {
                flex: 2
            },

            '& .mcp-server-form-oauth-section': {
                padding: spacing.sm,
                border: '1px solid #e8e8e8',
                borderRadius: 6,
                background: '#fafafa'
            }
        }
    });
});

export default useStyles;
