import { colors, spacing, rounded, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.task-list-card': {
            border: `1px solid ${colors.hairline}`,
            borderRadius: rounded.md,
            background: colors['surface-soft'],
            padding: spacing.sm,
            marginBottom: spacing.sm,
            fontSize: typography['body-sm'].fontSize,

            '& .task-list-card-header': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                marginBottom: spacing.xs,
                color: colors.primary,
                fontSize: typography.caption.fontSize
            },

            '& .task-list-card-title': {
                fontWeight: 600
            },

            '& .task-list-card-progress': {
                color: colors.muted,
                fontWeight: 500
            },

            '& .task-list-card-tool': {
                marginLeft: 'auto',
                color: colors['muted-soft'],
                fontSize: typography['caption-uppercase'].fontSize
            },

            '& .task-list-card-empty, & .task-list-card-warn': {
                color: colors.muted,
                padding: `${spacing.xxs}px 0`
            },

            '& .task-list-card-warn': {
                color: colors.warning
            },

            '& .task-list-card-list': {
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: spacing.xxs,
                maxHeight: 240,
                overflowY: 'auto'
            },

            '& .task-list-card-item': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                color: colors.body,
                lineHeight: 1.5
            },

            '& .task-list-card-item--done .task-list-card-subject': {
                color: colors.muted,
                textDecoration: 'line-through'
            },

            '& .task-list-card-subject': {
                flex: 1,
                wordBreak: 'break-word'
            },

            '& .task-list-card-icon--done': {
                color: colors.success
            },
            '& .task-list-card-icon--doing': {
                color: colors.primary
            },
            '& .task-list-card-icon--blocked': {
                color: colors.warning
            },
            '& .task-list-card-icon--pending': {
                color: colors['muted-soft']
            },

            '& .task-list-card-blocked-tag': {
                margin: 0,
                fontSize: typography['caption-uppercase'].fontSize
            }
        }
    });
});

export default useStyles;
