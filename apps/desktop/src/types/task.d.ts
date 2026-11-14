import type { Task, TaskStatus } from '@zhuixun/shared';

/** 契约 DTO（Task/TaskStatus）复用 @zhuixun/shared，这里转发并补充前端工具返回结构。 */
export type { Task, TaskStatus };

/** TaskCreate/TaskUpdate/TaskList 工具的 execute 返回结构 */
export interface TaskToolOutput {
    ok?: boolean;
    message?: string;
    tasks?: Task[];
}
