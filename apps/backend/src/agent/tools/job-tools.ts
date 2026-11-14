import type { JobCreateRequest, JobView } from '@zhuixun/shared';
import { tool } from 'ai';
import { z } from 'zod';

/**
 * 后台任务（Job）工具 —— 让模型把长任务丢到后台跑，不阻塞当前对话。
 *
 * 与定时任务工具一样**只挂载在交互式 agent**（routed/progressive），无人值守执行轮不挂，
 * 避免后台任务里再无限派生子任务。
 */
export interface JobToolPort {
    start(input: JobCreateRequest): Promise<JobView>;
    list(): Promise<JobView[]>;
    get(id: string): Promise<JobView | null>;
    cancel(id: string): Promise<JobView | null>;
}

/**
 * 装配后台任务工具集。
 * @param port 任务服务端口（装配点注入 JobService）
 * @param defaultSessionId 当前会话 id：任务完成后回到该会话唤醒用户，缺省不唤醒只落库。
 */
export function createJobTools(port: JobToolPort, defaultSessionId?: string) {
    return {
        JobStart: tool({
            description: [
                '把一个耗时较长、可以独立完成的子任务放到后台执行，立即返回任务 id，不阻塞当前对话。',
                '适合「帮我在后台整理这份资料」「先去跑一遍检查，完成后告诉我」这类诉求。',
                '后台任务完成后会把结果写入当前会话，并自动唤醒你继续向用户汇报。',
                '任务指令必须自包含：后台执行轮看不到这段对话，也不会向用户追问。'
            ].join(''),
            inputSchema: z.object({
                title: z.string().optional().describe('任务标题，简短可读；缺省取指令前 30 字'),
                prompt: z.string().describe('要后台执行的完整指令，自包含、可独立完成'),
                ownerSessionId: z.string().optional().describe('结果回到哪个会话；缺省固定为当前会话，一般不用传')
            }),
            execute: async ({ title, prompt, ownerSessionId }) => {
                const job = await port.start({
                    title,
                    prompt,
                    ownerSessionId: ownerSessionId ?? defaultSessionId
                });
                return { ok: true, job };
            }
        }),

        JobList: tool({
            description: '列出后台任务及状态（排队/执行中/成功/失败/已取消）。',
            inputSchema: z.object({}),
            execute: async () => ({ jobs: await port.list() })
        }),

        JobStatus: tool({
            description: '查看某个后台任务的当前状态与结果摘要。',
            inputSchema: z.object({ id: z.string().describe('后台任务 id') }),
            execute: async ({ id }) => {
                const job = await port.get(id);
                return job ? { ok: true, job } : { ok: false, error: `后台任务 ${id} 不存在` };
            }
        }),

        JobCancel: tool({
            description: '取消一个排队中或执行中的后台任务。',
            inputSchema: z.object({ id: z.string().describe('后台任务 id') }),
            execute: async ({ id }) => {
                const job = await port.cancel(id);
                return job ? { ok: true, job } : { ok: false, error: `后台任务 ${id} 不存在或已结束` };
            }
        })
    };
}
