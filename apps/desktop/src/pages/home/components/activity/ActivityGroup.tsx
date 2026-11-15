import { DownOutlined, ToolOutlined, WarningFilled } from '@ant-design/icons';
import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ChatScrollContext } from '../chat-scroll-context';

import useStyles from './ActivityGroup/styles';
import { formatDuration } from './format';
import { CATEGORY_LABEL, summarizeWork, type ToolItem } from './model';
import { TimelineToolItem } from './TimelineToolItem';

interface ActivityGroupProps {
    items: ToolItem[];
}

function countsText(summary: ReturnType<typeof summarizeWork>): string {
    return summary.counts.map(({ category, count }) => `${CATEGORY_LABEL[category]} ${count}`).join(' · ');
}

/**
 * 连续工具调用的聚合组。
 *
 * 默认显示组头摘要，待审批的工具在折叠时也保留操作入口。
 */
export const ActivityGroup = memo(function ActivityGroup({ items }: ActivityGroupProps) {
    const { styles, cx } = useStyles();
    const { stopScroll } = useContext(ChatScrollContext);
    const summary = useMemo(() => summarizeWork(items), [items]);
    const [expanded, setExpanded] = useState(false);
    const activeSinceRef = useRef<number | null>(null);
    const accumulatedRef = useRef(0);
    const [durationMs, setDurationMs] = useState<number | null>(null);
    // 只累计「工具真正在执行」的时间，排除等待用户审批的空档；否则用户思考 5 分钟会显示成工具跑了 5 分钟
    const anyRunning = items.some((item) => item.status === 'preparing' || item.status === 'running');

    useEffect(() => {
        if (anyRunning) {
            activeSinceRef.current ??= Date.now();
            return;
        }
        if (activeSinceRef.current != null) {
            accumulatedRef.current += Date.now() - activeSinceRef.current;
            activeSinceRef.current = null;
        }
        if (summary.allSettled && accumulatedRef.current > 0) {
            setDurationMs(accumulatedRef.current);
        }
    }, [anyRunning, summary.allSettled]);

    const pendingItems = items.filter((item) => item.status === 'waiting-approval');
    const visibleItems = expanded ? items : pendingItems;
    const statusLabel = summary.allSettled ? '已执行' : summary.running ? '正在执行' : '等待审批';
    const label = `${statusLabel} ${items.length} 个操作`;
    const counts = countsText(summary);

    return (
        <div className={cx('activity-group', summary.attention && 'has-attention', styles.toString())}>
            <button
                type="button"
                className="activity-group-header"
                aria-expanded={expanded}
                onClick={() => {
                    stopScroll();
                    setExpanded(!expanded);
                }}
            >
                <ToolOutlined className="activity-group-icon" />
                <span className="activity-group-label">{label}</span>
                {durationMs != null && <span className="activity-group-duration">· {formatDuration(durationMs)}</span>}
                {counts && <span className="activity-group-counts">{counts}</span>}
                {!summary.allSettled && summary.running && (
                    <span className="activity-group-running" title={summary.running.detail}>
                        {summary.running.detail}
                    </span>
                )}
                {summary.autoApprovedCount > 0 && (
                    <span className="activity-group-auto">自动放行 {summary.autoApprovedCount}</span>
                )}
                {(summary.attention || summary.warningCount > 0) && (
                    <span className="activity-group-attention">
                        <WarningFilled /> {summary.attention ? '需处理' : '需注意'}
                        {summary.warningCount > 0 ? ` ${summary.warningCount}` : ''}
                    </span>
                )}
                <DownOutlined className={cx('activity-group-chevron', expanded && 'is-expanded')} />
            </button>
            {visibleItems.length > 0 && (
                <div className="activity-group-body">
                    {visibleItems.map((item) => (
                        <TimelineToolItem key={item.toolCallId} item={item} />
                    ))}
                </div>
            )}
        </div>
    );
});

export default ActivityGroup;
