import { Popover, Progress } from 'antd';

import { useTokenUsage } from '@/hooks';
import { formatPercent, formatTokenCount } from '@/utils/formatTokens';

import { useChatMessages } from '../chat-context';

import useStyles from './styles';

/**
 * 会话 token 用量 / 剩余上下文指示器。
 *
 * 纯派生展示组件：消费 useTokenUsage(messages)，按 加载 / 占位 / 降级 / 正常 / 溢出 分支渲染
 * 「已用 token + 剩余上下文进度条/百分比」，hover 展开 input/output/cached 明细。无本地状态。
 *
 * messages 取自 ChatMessagesContext：流式中会重渲染，但只是几个数字与 Progress，
 * 取数（pickLatestUsage）已改为倒序提前退出，成本不随会话长度增长。
 */
export function TokenUsageIndicator() {
    const { styles, cx } = useStyles();
    const messages = useChatMessages();
    const {
        usedTokens,
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
        contextWindow,
        remaining,
        remainingPercent,
        hasUsage,
        loading
    } = useTokenUsage(messages);

    if (!hasUsage) {
        return loading ? (
            <div className={cx('token-usage-indicator', 'is-loading', styles.toString())}>
                <span className="token-usage-indicator-text">用量加载中…</span>
            </div>
        ) : null;
    }

    const hasWindow = contextWindow !== undefined;
    // 进度条表示已占用比例（100 − 剩余%）；溢出时剩余为 0 → 满格 exception
    const usedPercent =
        hasWindow && remainingPercent !== undefined
            ? Math.min(100, Math.max(0, Math.round(100 - remainingPercent)))
            : 0;
    const isOverflow = hasWindow && remainingPercent === 0;

    const detail = (
        <div className={cx('token-usage-indicator-detail', styles.toString())}>
            <div className="token-usage-indicator-detail-row">
                <span className="token-usage-indicator-detail-label">输入</span>
                <span className="token-usage-indicator-detail-value">{formatTokenCount(inputTokens)}</span>
            </div>
            <div className="token-usage-indicator-detail-row">
                <span className="token-usage-indicator-detail-label">输出</span>
                <span className="token-usage-indicator-detail-value">{formatTokenCount(outputTokens)}</span>
            </div>
            {cachedTokens !== undefined && (
                <div className="token-usage-indicator-detail-row">
                    <span className="token-usage-indicator-detail-label">缓存命中</span>
                    <span className="token-usage-indicator-detail-value">{formatTokenCount(cachedTokens)}</span>
                </div>
            )}
            {cacheWriteTokens !== undefined && cacheWriteTokens > 0 && (
                <div className="token-usage-indicator-detail-row">
                    <span className="token-usage-indicator-detail-label">缓存写入</span>
                    <span className="token-usage-indicator-detail-value">{formatTokenCount(cacheWriteTokens)}</span>
                </div>
            )}
            <div className="token-usage-indicator-detail-sep" />
            <div className="token-usage-indicator-detail-row">
                <span className="token-usage-indicator-detail-label">已用合计</span>
                <span className="token-usage-indicator-detail-value">{formatTokenCount(usedTokens)}</span>
            </div>
        </div>
    );

    // 降级态：有用量但上限未知（未配置 contextWindow / 取数失败 / 未知模型）→ 仅显已用，隐藏进度
    const modifier = !hasWindow ? 'is-degraded' : '';

    return (
        <Popover content={detail} trigger="hover" placement="bottomRight">
            <div className={cx('token-usage-indicator', modifier, styles.toString())}>
                <span className="token-usage-indicator-text">已用 {formatTokenCount(usedTokens)}</span>
                {hasWindow ? (
                    <>
                        <span className="token-usage-indicator-progress">
                            <Progress
                                percent={usedPercent}
                                showInfo={false}
                                size="small"
                                status={isOverflow ? 'exception' : 'normal'}
                            />
                        </span>
                        <span className="token-usage-indicator-percent">
                            剩余 {formatTokenCount(remaining)} · {formatPercent(remainingPercent)}
                        </span>
                    </>
                ) : (
                    <span className="token-usage-indicator-text">· 上限未知</span>
                )}
            </div>
        </Popover>
    );
}

export default TokenUsageIndicator;
