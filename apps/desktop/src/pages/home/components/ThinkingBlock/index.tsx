import { Think } from '@ant-design/x';
import { memo, useContext, useEffect, useRef, useState } from 'react';

import { firstLine, formatDuration, lastLine, truncateSingleLine } from '../activity/format';
import { ChatScrollContext } from '../chat-scroll-context';
import { StreamingMarkdown } from '../StreamingMarkdown';

import useStyles from './styles';

interface ThinkingBlockProps {
    /** 推理过程文本（AI SDK reasoning part 的 text） */
    text: string;
    /** 该 reasoning part 是否已完成（state === 'done'） */
    done: boolean;
}

/**
 * 助手「思考过程」折叠块。
 *
 * 与成熟实现保持一致：默认收起，流式中只显示一行滚动摘要，结束后显示耗时；
 * 正文只在展开时挂载，避免长思考逐 chunk 重解析 Markdown。
 * 用户手动展开后不再被任何自动策略收起（本组件没有自动收起）。
 */
export const ThinkingBlock = memo(function ThinkingBlock({ text, done }: ThinkingBlockProps) {
    const { styles, cx } = useStyles();
    const { stopScroll } = useContext(ChatScrollContext);
    const [expanded, setExpanded] = useState(false);
    const [durationMs, setDurationMs] = useState<number | null>(null);
    // 只在「挂载时还在流式中」的情况下计时；历史消息挂载时已 done，不伪造耗时
    const startRef = useRef<number | null>(done ? null : Date.now());
    const durationRef = useRef<number | null>(null);

    useEffect(() => {
        if (!done || startRef.current == null || durationRef.current != null) return;
        durationRef.current = Date.now() - startRef.current;
        setDurationMs(durationRef.current);
    }, [done]);

    const label = done ? (durationMs != null ? `已思考 ${formatDuration(durationMs)}` : '已思考') : '思考中…';
    const summaryText = truncateSingleLine(done ? firstLine(text) : lastLine(text), 100);

    const handleExpand = (next: boolean) => {
        stopScroll();
        setExpanded(next);
    };

    return (
        <div className={cx('thinking-block', styles.toString())}>
            <Think
                title={
                    <span className="thinking-title">
                        <span className={cx('thinking-label', !done && 'is-running')}>{label}</span>
                        {!expanded && summaryText && <span className="thinking-summary">{summaryText}</span>}
                    </span>
                }
                loading={!done}
                expanded={expanded}
                onExpand={handleExpand}
            >
                <StreamingMarkdown text={text} streaming={!done} />
            </Think>
        </div>
    );
});

export default ThinkingBlock;
