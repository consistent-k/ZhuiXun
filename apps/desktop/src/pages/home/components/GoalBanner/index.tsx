import { LoadingOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { App, Button, Tag, Tooltip } from 'antd';
import { useEffect } from 'react';

import { useChatStore, useSessionRuntimeStore } from '@/stores';

import useStyles from './styles';

/**
 * 自驱循环（Goal）状态条：显示当前会话是否在自动推进、轮次进度，并提供「停止」。
 *
 * 状态真源在后端进程内存（不持久化），这里只做镜像：打开会话时拉一次，之后靠 session SSE 更新。
 */
export function GoalBanner() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const sessionId = useChatStore((s) => s.currentConversationId);
    const goal = useSessionRuntimeStore((s) => (sessionId ? s.goals[sessionId] : undefined));
    const loadGoal = useSessionRuntimeStore((s) => s.loadGoal);
    const disarmGoal = useSessionRuntimeStore((s) => s.disarmGoal);

    // 打开会话时补拉一次：SSE 只推变化，历史状态要靠这里补齐。
    useEffect(() => {
        if (sessionId && !goal) void loadGoal(sessionId);
    }, [sessionId, goal, loadGoal]);

    if (!goal || goal.status === 'disarmed') return null;

    const running = goal.status === 'running';
    const blocked = goal.status === 'blocked';
    const tagColor = blocked ? 'default' : running ? 'processing' : 'blue';
    const label = blocked
        ? `自驱已停止${goal.note ? ` · ${goal.note}` : ''}`
        : running
          ? `自驱进行中 · 第 ${goal.roundsStarted}/${goal.maxRounds} 轮`
          : `自驱已开启 · 0/${goal.maxRounds} 轮`;

    const handleStop = async () => {
        if (!sessionId) return;
        await disarmGoal(sessionId);
        message.success('已停止自驱循环');
    };

    return (
        <div className={cx('goal-banner', styles.toString())}>
            <Tag
                color={tagColor}
                icon={running ? <LoadingOutlined /> : <ThunderboltOutlined />}
                className="goal-banner-tag"
            >
                {label}
            </Tag>
            <Tooltip title={goal.goal}>
                <span className="goal-banner-text">{goal.goal}</span>
            </Tooltip>
            {!blocked && (
                <Button size="small" type="text" className="goal-banner-stop" onClick={() => void handleStop()}>
                    停止
                </Button>
            )}
            {blocked && (
                <Button size="small" type="text" className="goal-banner-stop" onClick={() => void handleStop()}>
                    关闭
                </Button>
            )}
        </div>
    );
}
