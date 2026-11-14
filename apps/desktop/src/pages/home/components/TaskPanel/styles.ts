import { colors, spacing, rounded, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.task-panel': {
            border: `1px solid ${colors.hairline}`,
            borderRadius: rounded.md,
            background: colors['surface-soft'],
            margin: `0 ${spacing.md}px ${spacing.xs}px`,
            fontSize: typography['body-sm'].fontSize,
            overflow: 'hidden',

            '& .task-panel-header': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                width: '100%',
                padding: `${spacing.xs}px ${spacing.sm}px`,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: colors.primary,
                fontSize: typography.caption.fontSize,
                textAlign: 'left'
            },

            '& .task-panel-header-icon': {
                color: colors.primary
            },

            '& .task-panel-title': {
                fontWeight: 600
            },

            '& .task-panel-progress': {
                color: colors.muted,
                fontWeight: 500
            },

            '& .task-panel-current': {
                marginLeft: 'auto',
                color: colors.body,
                fontWeight: 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '55%'
            },

            '& .task-panel-list': {
                listStyle: 'none',
                margin: 0,
                padding: `${spacing.xs}px ${spacing.sm}px ${spacing.sm}px`,
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xxs,
                maxHeight: 180,
                overflowY: 'auto'
            },

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
