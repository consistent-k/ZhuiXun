import { colors, spacing, typography } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.skills-page': {
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            background: colors.canvas,

            // 给仅在技能标签显示的广场按钮预留标题栏高度，避免标签页上下跳动。
            '& > .skills-page-header': {
                minHeight: 57
            },

            '& .skills-page-title': {
                fontFamily: typography['title-sm'].fontFamily,
                fontSize: typography['title-sm'].fontSize,
                fontWeight: 600,
                color: colors.ink
            },

            '--extension-gutter': `clamp(${spacing.md}px, 4vw, 48px)`,
            '--extension-width': '920px',

            '& .skills-page-tabs': {
                flex: 1,
                minHeight: 0,
                '& [class$="-tabs-nav"]': {
                    marginBottom: 0,
                    paddingInline: 'var(--extension-gutter)'
                },
                // antd 6 的标签页由 body-holder、body 和 role=tabpanel 组成。
                // 限制这三层的高度，让技能列表或连接器面板保有自己的滚动区。
                '& > [class$="-tabs-body-holder"]': { minHeight: 0, overflow: 'hidden' },
                '& .skills-page-tab-body, & .skills-page-tab-content': { height: '100%' },
                '& .skills-page-tab-content:not([aria-hidden="true"])': {
                    display: 'flex',
                    flexDirection: 'column'
                }
            }
        }
    });
});

export default useStyles;
