/** tasks 模块公开契约：会话任务清单（每会话一文件）。模块外只从这里 import。 */
export type { Task, TaskStatus } from '@zhuixun/shared';
export type { TaskBatchResult, TaskCreateInput, TaskUpdateInput } from './store';
export { buildInjectedTasks, createTaskStore, getTaskStore } from './store';
