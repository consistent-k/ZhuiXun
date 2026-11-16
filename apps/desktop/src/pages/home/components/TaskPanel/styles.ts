import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.task-panel-list': {
            listStyle: 'none',
            margin: 0,
            padding: 0,
            width: 'min(296px, calc(100vw - 48px))',
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.xs,
            maxHeight: 240,
            overflowY: 'auto',
            fontSize: typography['body-sm'].fontSize,

            '& .task-panel-item': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                color: colors.body,
                lineHeight: 1.5
            },

            '& .task-panel-item--done .task-panel-subject': {
                color: colors.muted,
                textDecoration: 'line-through'
            },

            '& .task-panel-subject': {
                flex: 1,
                wordBreak: 'break-word'
            },

            '& .task-panel-blocked': {
                color: colors.warning,
                fontSize: typography['caption-uppercase'].fontSize
            },

            '& .task-panel-icon--done': { color: colors.success },
            '& .task-panel-icon--doing': { color: colors.primary },
            '& .task-panel-icon--blocked': { color: colors.warning },
            '& .task-panel-icon--pending': { color: colors['muted-soft'] }
        }
    });
});

export default useStyles;
