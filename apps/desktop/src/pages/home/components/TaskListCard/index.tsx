import {
    CheckCircleFilled,
    ClockCircleOutlined,
    LoadingOutlined,
    LockOutlined,
    OrderedListOutlined
} from '@ant-design/icons';
import { Tag } from 'antd';
import { memo, useMemo } from 'react';

import type { Task, TaskToolOutput } from '@/types/task';

import useStyles from './styles';

export interface TaskListCardProps {
    /** 工具名（TaskCreate / TaskUpdate / TaskList） */
    toolName: string;
    /** 工具调用状态：input-streaming / input-available / output-available / output-error */
    state: string;
    /** 工具 execute 的返回（含全量 tasks 或软错误 message） */
    output?: unknown;
    /** output-error 时的错误文本（如 zod 校验失败） */
    errorText?: string;
}

/** 某任务是否被未完成的前置任务阻塞（派生态，不落枚举） */
function isBlocked(task: Task, completedIds: Set<string>): boolean {
    return task.blockedBy.some((id) => !completedIds.has(id));
}

/** 单行任务状态图标 */
function StatusIcon({ task, blocked }: { task: Task; blocked: boolean }) {
    if (task.status === 'completed') return <CheckCircleFilled className="task-list-card-icon--done" />;
    if (task.status === 'in_progress') return <LoadingOutlined className="task-list-card-icon--doing" />;
    if (blocked) return <LockOutlined className="task-list-card-icon--blocked" />;
    return <ClockCircleOutlined className="task-list-card-icon--pending" />;
}

export const TaskListCard = memo(function TaskListCard({ toolName, state, output, errorText }: TaskListCardProps) {
    const { styles, cx } = useStyles();

    const data = (output ?? {}) as TaskToolOutput;
    const running = state === 'input-streaming' || state === 'input-available';
    const failed = state === 'output-error';

    const tasks = useMemo<Task[]>(() => (output as TaskToolOutput | undefined)?.tasks ?? [], [output]);
    const completedIds = useMemo(
        () => new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id)),
        [tasks]
    );
    const doneCount = completedIds.size;

    return (
        <div className={cx('task-list-card', styles.toString())}>
            <div className="task-list-card-header">
                <OrderedListOutlined />
                <span className="task-list-card-title">任务清单</span>
                {tasks.length > 0 && (
                    <span className="task-list-card-progress">
                        {doneCount}/{tasks.length}
                    </span>
                )}
                <span className="task-list-card-tool">{toolName}</span>
            </div>

            {failed ? (
                <div className="task-list-card-warn">任务更新失败{errorText ? `：${errorText}` : ''}</div>
            ) : running && tasks.length === 0 ? (
                <div className="task-list-card-empty">
                    <LoadingOutlined /> 正在更新任务清单...
                </div>
            ) : data.ok === false ? (
                <div className="task-list-card-warn">更新未生效：{data.message || '未知原因'}</div>
            ) : tasks.length === 0 ? (
                <div className="task-list-card-empty">暂无任务</div>
            ) : (
                <ul className="task-list-card-list">
                    {tasks.map((task) => {
                        const blocked = task.status !== 'completed' && isBlocked(task, completedIds);
                        return (
                            <li
                                key={task.id}
                                className={cx(
                                    'task-list-card-item',
                                    task.status === 'completed' && 'task-list-card-item--done'
                                )}
                            >
                                <StatusIcon task={task} blocked={blocked} />
                                <span className="task-list-card-subject">
                                    {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}
                                </span>
                                {blocked && (
                                    <Tag className="task-list-card-blocked-tag" variant="filled">
                                        阻塞中 · 依赖 {task.blockedBy.join(', ')}
                                    </Tag>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
});
