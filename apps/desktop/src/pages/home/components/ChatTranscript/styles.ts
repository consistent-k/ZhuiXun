import { colors, rounded, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        // 消息区外壳：撑满 ChatArea 剩余高度，承载滚动容器与悬浮的「回到底部」按钮
        '&.chat-transcript': {
            position: 'relative',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column'
        },

        // 真正的滚动容器（ref 交给 use-stick-to-bottom）
        '& .chat-transcript-scroll': {
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            // 横向溢出裁掉而不是出滚动条：流式中表格撑宽时不会让垂直滚动区抖动
            overflowX: 'clip',
            // 关闭浏览器原生滚动锚定：跟随位置统一由弹簧动画管理，避免两套机制互相修正
            overflowAnchor: 'none'
        },

        // 内容包裹层（ref 交给 use-stick-to-bottom 的 ResizeObserver）
        '& .chat-transcript-inner': {
            minHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            maxWidth: 'calc(var(--chat-column-width) + 2 * var(--chat-gutter))',
            marginInline: 'auto',
            padding: `${spacing.lg}px var(--chat-gutter)`
        },

        '& .chat-transcript-loading': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1
        },

        '& .chat-transcript-notice': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.xs,
            marginTop: spacing.md,
            color: colors.muted,
            fontFamily: typography['body-sm'].fontFamily,
            fontSize: typography['body-sm'].fontSize
        },

        // 回到底部：悬浮在滚动区右下角，不参与内容布局
        '& .chat-transcript-back-bottom': {
            position: 'absolute',
            right: spacing.lg,
            bottom: spacing.md,
            zIndex: 2,
            color: colors.primary,
            background: colors['surface-card'],
            borderColor: colors.hairline,
            borderRadius: rounded.full,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)'
        }
    });
});

export default useStyles;
