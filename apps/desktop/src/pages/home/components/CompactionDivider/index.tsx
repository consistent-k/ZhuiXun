import { CompressOutlined } from '@ant-design/icons';
import type { CompactionMarker } from '@zhuixun/shared';
import { Tooltip } from 'antd';

import useStyles from './styles';

interface CompactionDividerProps {
    marker?: CompactionMarker;
    /** 用户经 /compact 手动触发 */
    manual?: boolean;
}

/** 聊天区分隔条：标记此处发生了一次上下文压缩（历史仍完整保留，仅模型输入被压缩）。 */
export function CompactionDivider({ marker, manual }: CompactionDividerProps) {
    const { styles, cx } = useStyles();
    const parts: string[] = [];
    if (marker?.summarizedCount) parts.push(`已折叠 ${marker.summarizedCount} 条早期消息`);
    if (marker?.tokensBefore && marker?.tokensAfter) {
        parts.push(`约 ${marker.tokensBefore} → ${marker.tokensAfter} tokens`);
    }
    const detail =
        parts.length > 0 ? parts.join('，') : '为节省上下文，较早的对话已自动摘要压缩；完整历史仍保留在此会话中。';

    return (
        <div className={cx('compaction-divider', styles.toString())}>
            <span className="compaction-divider-line" />
            <Tooltip title={detail}>
                <span className="compaction-divider-label">
                    <CompressOutlined />
                    {manual ? '上下文已手动压缩' : '上下文已自动压缩'}
                </span>
            </Tooltip>
            <span className="compaction-divider-line" />
        </div>
    );
}

export default CompactionDivider;
