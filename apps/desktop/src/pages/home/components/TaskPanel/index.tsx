import {
    CheckCircleFilled,
    ClockCircleOutlined,
    DownOutlined,
    LoadingOutlined,
    LockOutlined,
    OrderedListOutlined,
    RightOutlined
} from '@ant-design/icons';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { memo, useMemo, useState } from 'react';

import type { Task, TaskToolOutput } from '@/types/task';

import { useChatMessages } from '../chat-context';

import useStyles from './styles';

/** 任务清单工具名（后端 core/tools/task-tools.ts） */
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList']);

/**
 * 从消息流派生「当前」任务清单：取最后一次带 tasks 的任务工具 output。
 * 软错误（ok:false 无 tasks）不覆盖上一份有效清单，保持面板显示最新有效状态。
 *
 * 倒序扫描：流式中每个 token 都会调用一次，只需「最后一份」有效清单，无需遍历全部历史。
 */
function deriveLatestTasks(messages: UIMessage[]): Task[] {
    for (let i = messages.length - 1; i >= 0; i--) {
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
 * 常驻任务清单面板：挂在输入框上方，只显示「当前」这一份清单并原地更新。
 * 与消息流里的内联 TaskListCard（历史轨迹）互补。无任务时不渲染。
 *
 * 分两层：外层订阅 messages 并派生 tasks（每 token 执行一次 O(1) 倒序扫描）；
 * 内层 memo 只在 tasks 数组引用变化时重渲染——流式正文增长不影响任务对象，故内层被跳过。
 */
export function TaskPanel() {
    const messages = useChatMessages();
    const tasks = useMemo(() => deriveLatestTasks(messages), [messages]);
    return <TaskPanelView tasks={tasks} />;
}

const TaskPanelView = memo(function TaskPanelView({ tasks }: TaskPanelViewProps) {
    const { styles, cx } = useStyles();
    const [collapsed, setCollapsed] = useState(false);

    const completedIds = useMemo(
        () => new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id)),
        [tasks]
    );

    const doneCount = completedIds.size;
    // 无任务、或全部任务已完成时都不常驻：完成后面板自动收起，历史轨迹仍留在会话流的内联卡片
    if (tasks.length === 0 || doneCount === tasks.length) return null;

    const current = tasks.find((t) => t.status === 'in_progress');

    return (
        <div className={cx('task-panel', styles.toString())}>
            <button type="button" className="task-panel-header" onClick={() => setCollapsed((v) => !v)}>
                {collapsed ? <RightOutlined /> : <DownOutlined />}
                <OrderedListOutlined className="task-panel-header-icon" />
                <span className="task-panel-title">任务清单</span>
                <span className="task-panel-progress">
                    {doneCount}/{tasks.length}
                </span>
                {collapsed && current && (
                    <span className="task-panel-current">
                        <LoadingOutlined /> {current.activeForm || current.subject}
                    </span>
                )}
            </button>

            {!collapsed && (
                <ul className="task-panel-list">
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
            )}
        </div>
    );
});

export default TaskPanel;
