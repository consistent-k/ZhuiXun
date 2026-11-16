import {
    CheckCircleFilled,
    ClockCircleOutlined,
    LoadingOutlined,
    LockOutlined,
    OrderedListOutlined
} from '@ant-design/icons';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { Button, Popover } from 'antd';
import { memo, useMemo, useState } from 'react';

import type { Task, TaskToolOutput } from '@/types/task';

import { useChatMessages } from '../chat-context';

import useStyles from './styles';

/** 可返回完整任务清单的工具 */
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList']);

/**
 * 从消息流派生「当前」任务清单：取最后一次带 tasks 的任务工具 output。
 * 软错误（ok:false 无 tasks）不覆盖上一份有效清单，保持面板显示最新有效状态。
 *
 * 倒序扫描：流式中每个 token 都会调用一次，只需「最后一份」有效清单，无需遍历全部历史。
 */
function deriveLatestTasks(messages: UIMessage[]): Task[] {
    for (let i = messages.length - 1; i >= 0; i--) {
        // 新一轮尚未返回任务快照时，避免重新展示上一轮遗留的任务。
        if (messages[i].role === 'user') break;
        const parts = messages[i].parts;
        for (let j = parts.length - 1; j >= 0; j--) {
            const part = parts[j];
            if (isToolUIPart(part) && TASK_TOOLS.has(getToolName(part)) && 'output' in part) {
                const out = part.output as TaskToolOutput | undefined;
                if (out?.tasks) return out.tasks;
            }
        }
    }
    return [];
}

function isBlocked(task: Task, completedIds: Set<string>): boolean {
    return task.status !== 'completed' && task.blockedBy.some((id) => !completedIds.has(id));
}

function StatusIcon({ task, blocked }: { task: Task; blocked: boolean }) {
    if (task.status === 'completed') return <CheckCircleFilled className="task-panel-icon--done" />;
    if (task.status === 'in_progress') return <LoadingOutlined className="task-panel-icon--doing" />;
    if (blocked) return <LockOutlined className="task-panel-icon--blocked" />;
    return <ClockCircleOutlined className="task-panel-icon--pending" />;
}

interface TaskPanelViewProps {
    tasks: Task[];
}

/**
 * 标题栏里的实时任务进度。由会话运行态控制挂载，避免模型漏写最终 TaskUpdate 时一直显示。
 * 历史工具调用仍由消息流里的内联 TaskListCard 展示。
 */
export function TaskPanel() {
    const messages = useChatMessages();
    const tasks = useMemo(() => deriveLatestTasks(messages), [messages]);
    return <TaskPanelView tasks={tasks} />;
}

const TaskPanelView = memo(function TaskPanelView({ tasks }: TaskPanelViewProps) {
    const { styles, cx } = useStyles();
    const [open, setOpen] = useState(false);

    const completedIds = useMemo(
        () => new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id)),
        [tasks]
    );

    const doneCount = completedIds.size;
    // 仅在当前轮有未完成任务时显示实时入口。
    if (tasks.length === 0 || doneCount === tasks.length) return null;

    return (
        <Popover
            title="任务清单"
            placement="bottomRight"
            trigger="click"
            open={open}
            onOpenChange={setOpen}
            destroyOnHidden
            content={
                <ul className={cx('task-panel-list', styles.toString())}>
                    {tasks.map((task) => {
                        const blocked = isBlocked(task, completedIds);
                        return (
                            <li
                                key={task.id}
                                className={cx(
                                    'task-panel-item',
                                    task.status === 'completed' && 'task-panel-item--done'
                                )}
                            >
                                <StatusIcon task={task} blocked={blocked} />
                                <span className="task-panel-subject">
                                    {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}
                                </span>
                                {blocked && (
                                    <span className="task-panel-blocked">依赖 {task.blockedBy.join(', ')}</span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            }
        >
            <Button
                type="text"
                size="small"
                icon={<OrderedListOutlined />}
                aria-label={`任务清单，已完成 ${doneCount}/${tasks.length}`}
                aria-expanded={open}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') setOpen(false);
                }}
            >
                {doneCount}/{tasks.length}
            </Button>
        </Popover>
    );
});

export default TaskPanel;
