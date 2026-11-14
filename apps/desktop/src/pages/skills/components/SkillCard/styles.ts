import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.skill-card': {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            cursor: 'pointer',
            padding: `${spacing.sm}px ${spacing.md}px`,
            background: colors.canvas,
            border: `1px solid ${colors.hairline}`,
            borderRadius: rounded.lg,
            transition: 'all 0.2s ease',

            '&:hover': {
                borderColor: colors['surface-cream-strong'],
                background: colors['surface-soft']
            },

            '&.disabled': {
                '& .skill-card-name, & .skill-card-description': { color: colors.muted }
            },

            '& .skill-card-header': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.sm,
                marginBottom: spacing.xs
            },

            '& .skill-card-name': {
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: typography['title-sm'].fontWeight,
                color: colors.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 1.45
            },

            '& .skill-card-switch': {
                flexShrink: 0
            },

            '& .skill-card-description': {
                display: '-webkit-box',
                WebkitLineClamp: 2,
                // 多行省略依赖此属性与 -webkit-line-clamp 配合，MDN 明确该组合仍受支持。
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                fontFamily: typography['body-sm'].fontFamily,
                fontSize: typography['body-sm'].fontSize,
                lineHeight: typography['body-sm'].lineHeight,
                color: colors.muted
            },

            '& .skill-card-footer': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.xs,
                marginTop: spacing.xs
            },

            '& .skill-card-meta': {
                display: 'flex',
                alignItems: 'center',
                gap: spacing.xs,
                minWidth: 0
            },

            '& .skill-card-tool-count': {
                fontSize: typography.caption.fontSize,
                color: colors['muted-soft'],
                whiteSpace: 'nowrap'
            },

            '& .skill-card-actions': {
                display: 'flex',
                gap: spacing.xxs
            }
        }
    });
});

export default useStyles;
