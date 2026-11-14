import type { CSSProperties, ReactNode } from 'react';

import { spacing } from '@/theme/tokens';

import useStyles, { WINDOW_CONTROLS_RESERVE } from './styles';

export { WINDOW_CONTROLS_RESERVE };

interface PageHeaderProps {
    /** 表头内容：按书写顺序从左排布；靠右控件用 marginLeft:auto 推到右侧 */
    children: ReactNode;
    /** 透传额外 className 做页面级微调 */
    className?: string;
    /** flex 间距，默认 spacing.sm(12px) */
    gap?: number;
    /** 垂直内边距，默认 spacing.sm(12px)；水平恒为 spacing.lg(24px) */
    paddingBlock?: number;
    /** 透传额外 inline 样式 */
    style?: CSSProperties;
}

/**
 * 全站统一页面表头。
 *
 * 把 Electron 自定义顶栏的窗口语义收敛到一处，各页不再各自重复这段样板：
 * - 整条表头兼作窗口拖拽区(-webkit-app-region: drag)，内部交互控件自动标 no-drag；
 * - win/linux 的系统三键经 titleBarOverlay 叠在右上角，表头右侧自动让位(见 WINDOW_CONTROLS_RESERVE)；
 *   mac 红绿灯在左上角、右侧无需让位；纯 web(无 window.zhuixun)也不让位。
 *
 * 内容自排版：直接把标题/按钮/分段器作 children 传入。
 */
export default function PageHeader({
    children,
    className,
    gap = spacing.sm,
    paddingBlock = spacing.sm,
    style
}: PageHeaderProps) {
    const { styles, cx } = useStyles();
    // 仅 Electron 下的 win/linux 才需为系统三键让位：mac 三键在左上角，纯 web 根本没有系统三键
    const platform = window.zhuixun?.platform;
    const reserveForWindowControls = !!platform && platform !== 'darwin';
    return (
        <div
            className={cx(
                'zhuixun-page-header',
                styles.toString(),
                reserveForWindowControls && 'platform-win',
                className
            )}
            style={{ gap, paddingBlock, ...style }}
        >
            {children}
        </div>
    );
}
