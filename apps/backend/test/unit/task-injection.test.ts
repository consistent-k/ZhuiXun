import { describe, expect, it } from 'vitest';

import type { Task } from '@/modules/tasks';
import { buildInjectedTasks } from '@/modules/tasks';

describe('buildInjectedTasks', () => {
    it('omits an empty task list', () => {
        expect(buildInjectedTasks([])).toBe('');
    });

    it('renders statuses and dependencies, showing activeForm only for an in-progress task', () => {
        const tasks: Task[] = [
            { id: '1', subject: 'First', status: 'completed', activeForm: 'Hidden', blocks: ['2'], blockedBy: [] },
            {
                id: '2',
                subject: 'Second',
                status: 'in_progress',
                activeForm: 'Working',
                blocks: ['3'],
                blockedBy: ['1']
            },
            { id: '3', subject: 'Third', status: 'pending', activeForm: 'Hidden', blocks: [], blockedBy: ['1', '2'] },
            { id: '4', subject: 'Fourth', status: 'in_progress', blocks: [], blockedBy: [] }
        ];
        const before = structuredClone(tasks);
        expect(buildInjectedTasks(tasks)).toBe(
            [
                '## 当前任务清单',
                '这是本会话的任务清单（真源在服务端）。请按 id 用 TaskUpdate 更新状态；',
                '同一时刻最多一个任务 in_progress；被未完成任务阻塞的任务不可置 in_progress。',
                '',
                '- [1] ✅ First',
                '- [2] 🔄 Second（Working） 依赖[1]',
                '- [3] ⬜ Third 依赖[1,2]',
                '- [4] 🔄 Fourth'
            ].join('\n')
        );
        expect(tasks).toEqual(before);
    });
});
