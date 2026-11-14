import type { Task } from '@zhuixun/shared';
import { tool } from 'ai';
import { z } from 'zod';

import type { TaskBatchResult, TaskCreateInput, TaskStatus, TaskUpdateInput } from '@/modules/tasks';

/**
 * 任务工具所需的最小存储端口（由调用方注入，agent 层不直接取模块单例）。
 * 由 modules/tasks 的 TaskStore 结构满足；类型只依赖 shared 的 Task。
 */
export interface TaskToolStore {
    list(sessionId?: string): Promise<Task[]>;
    create(sessionId: string | undefined, items: TaskCreateInput[]): Promise<Task[]>;
    updateMany(sessionId: string | undefined, patches: TaskUpdateInput[]): Promise<TaskBatchResult>;
}

/**
 * 任务清单工具（server 工具，含 execute、非阻塞、无需审批）。
 *
 * 与 askUserQuestion（客户端工具、无 execute、需用户回填）不同：任务更新不需要任何用户
 * 输入，必须立即返回、不打断对话流，由 ToolLoopAgent 在流内自动继续。真源是按 sessionId
 * 落盘的后端 store（modules/tasks）；每个写工具 execute 落盘后回显**全量清单**，
 * 前端据最后一次任务工具的 output 渲染清单卡片。
 *
 * @param store 任务存储（由 modules/chat 装配时注入）
 * @param sessionId 当前会话 id，作为任务 store 的 key（会话恒有 id）
 */
export function createTaskTools(store: TaskToolStore, sessionId?: string) {
    const statusEnum = z.enum(['pending', 'in_progress', 'completed']) satisfies z.ZodType<TaskStatus>;

    return {
        TaskCreate: tool({
            description: [
                '为当前多步骤任务创建任务清单（一次可建多条）。',
                '当任务包含 3 个及以上步骤、或用户给出多项要求时，开工前先建清单，让用户看到计划与进度。',
                '服务端会为每条任务分配自增 id；后续用 TaskUpdate 按 id 更新状态。',
                '不要为一两步的简单任务建清单。'
            ].join(''),
            inputSchema: z.object({
                tasks: z
                    .array(
                        z.object({
                            subject: z.string().describe('任务标题，用祈使句，如「排查 3001 端口占用」'),
                            description: z.string().optional().describe('可选：任务详情'),
                            activeForm: z
                                .string()
                                .optional()
                                .describe('可选：进行时描述，用「正在…」句式，如「正在排查端口占用」，勿写「待开始」')
                        })
                    )
                    .min(1)
                    .describe('要创建的任务列表')
            }),
            execute: async ({ tasks }) => {
                const all = await store.create(sessionId, tasks);
                return { ok: true, tasks: all };
            }
        }),

        TaskUpdate: tool({
            description: [
                '按 id 批量更新任务：改状态 / 标题 / 详情 / 进行时描述，或建立任务间依赖。',
                'updates 一次可传多笔——收尾时务必在一次调用里把多个任务一并置 completed，不要逐条调用、',
                '更不要把状态更新写成普通回复里的 JSON 文本（那样不会生效）。单笔更新传一个元素即可。',
                '每开始做一个任务前置为 in_progress、做完置 completed，及时更新以反映真实进度。',
                '约定：同一时刻最多只有一个任务处于 in_progress。',
                '依赖：addBlockedBy 声明本任务被哪些上游任务阻塞（上游需全部 completed 才能开始本任务），',
                'addBlocks 声明本任务阻塞哪些下游任务。成环会被拒绝，被阻塞时也无法置 in_progress。',
                '逐笔按给定顺序应用：可在同一批里先把前置置 completed、再解锁后置 in_progress。',
                '返回的 failed 数组列出未生效的更新及原因，据此修正后仅重试这些项。'
            ].join(''),
            inputSchema: z.object({
                updates: z
                    .array(
                        z.object({
                            taskId: z.coerce.string().describe('要更新的任务 id'),
                            status: statusEnum.optional().describe('新状态'),
                            subject: z.string().optional().describe('新标题'),
                            description: z.string().optional().describe('新详情'),
                            activeForm: z.string().optional().describe('新的进行时描述，用「正在…」句式'),
                            addBlocks: z.array(z.coerce.string()).optional().describe('本任务阻塞的下游任务 id'),
                            addBlockedBy: z.array(z.coerce.string()).optional().describe('阻塞本任务的上游任务 id')
                        })
                    )
                    .min(1)
                    .describe('一笔或多笔任务更新，按给定顺序逐笔应用')
            }),
            execute: async ({ updates }) => {
                return store.updateMany(sessionId, updates);
            }
        }),

        TaskList: tool({
            description: '列出当前会话的全部任务及其状态与依赖。当你需要确认任务 id 或整体进度时调用。',
            inputSchema: z.object({}),
            execute: async () => {
                const tasks = await store.list(sessionId);
                return { ok: true, tasks };
            }
        })
    };
}
