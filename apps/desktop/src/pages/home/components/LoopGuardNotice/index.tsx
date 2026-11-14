import { CaretRightOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TurnStopReason } from '@zhuixun/shared';
import { Alert, Button } from 'antd';

import useStyles from './styles';

interface LoopGuardNoticeProps {
    /** 后端写入 assistant 消息 metadata.stopReason 的停止原因 */
    reason: TurnStopReason;
    /** 本轮已执行的步数（max-steps 时展示） */
    steps?: number;
    /** 继续上一个任务（护栏截停时） */
    onContinue?: () => void;
    /** 重新生成本条回复（出错时） */
    onRetry?: () => void;
    /** 生成中禁用操作 */
    disabled?: boolean;
}

const REASON_TEXT: Record<TurnStopReason, (steps?: number) => string> = {
    'max-steps': (steps) => `已达到单轮步数上限${steps ? `（${steps} 步）` : ''}，任务可能尚未完成。`,
    'repeated-error': () => '同一操作连续失败，已暂停以避免反复重试。',
    'repeated-call': () => '检测到重复的相同操作，已暂停以避免陷入循环。',
    error: () => '本条回复因模型服务出错而中断。'
};

/** assistant 消息底部的停止提示：护栏截停给「继续」，出错给「重试」。 */
export function LoopGuardNotice({ reason, steps, onContinue, onRetry, disabled }: LoopGuardNoticeProps) {
    const { styles, cx } = useStyles();
    const isError = reason === 'error';
    const action = isError ? onRetry : onContinue;

    return (
        <Alert
            className={cx('loop-guard-notice', styles.toString())}
            type={isError ? 'error' : 'warning'}
            showIcon
            title={REASON_TEXT[reason](steps)}
            action={
                action && (
                    <Button
                        size="small"
                        icon={isError ? <ReloadOutlined /> : <CaretRightOutlined />}
                        disabled={disabled}
                        onClick={action}
                    >
                        {isError ? '重试' : '继续'}
                    </Button>
                )
            }
        />
    );
}

export default LoopGuardNotice;
