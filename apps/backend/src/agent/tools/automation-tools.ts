import type { AutomationCreateRequest, AutomationUpdateRequest, AutomationView } from '@zhuixun/shared';
import { tool } from 'ai';
import { z } from 'zod';

/**
 * 自动化任务（定时触发）工具 —— 让模型在对话里创建/查看/编辑/删除定时任务。
 *
 * 与任务清单工具（task-tools）同为 server 工具（含 execute、非阻塞、无需审批）；真源是后端
 * automation store（跨会话）。**仅挂载在交互式 agent（routed/progressive）**，自动化任务的无人值守
 * 执行轮刻意不挂这些工具（见 createAutomationRunAgent 注释），从构造上杜绝递归自派生。
 */

/** 工具所需的最小存储端口（由装配点注入 AutomationService，agent 层不取模块单例）。 */
export interface AutomationToolPort {
    list(filter?: 'enabled' | 'inactive' | 'all'): Promise<AutomationView[]>;
    create(input: AutomationCreateRequest, source?: 'ui' | 'tool'): Promise<AutomationView>;
    update(id: string, patch: AutomationUpdateRequest): Promise<AutomationView>;
    delete(id: string): Promise<void>;
}

const scheduleSchema = z
    .discriminatedUnion('kind', [
        z.object({ kind: z.literal('after'), afterSeconds: z.number().positive().describe('多少秒后触发一次') }),
        z.object({ kind: z.literal('at'), at: z.number().positive().describe('绝对触发时间，epoch 毫秒') }),
        z.object({ kind: z.literal('every'), everySeconds: z.number().min(60).describe('每隔多少秒触发，最小 60') }),
        z.object({
            kind: z.literal('daily'),
            time: z.string().describe('每天触发时间，"HH:mm"'),
            timeZone: z.string().optional()
        }),
        z.object({
            kind: z.literal('weekly'),
            time: z.string().describe('触发时间，"HH:mm"'),
            weekdays: z.array(z.number().min(0).max(6)).describe('星期，0=周日…6=周六'),
            timeZone: z.string().optional()
        }),
        z.object({
            kind: z.literal('cron'),
            expression: z.string().describe('五段 cron：分 时 日 月 周'),
            timeZone: z.string().optional()
        })
    ])
    .describe('触发规则');

/** 工具集可选钩子：created 后置位本轮的「建任务后锁工具」标记（见 runner 的 TurnFlags）。 */
export interface AutomationToolHooks {
    onCreated?: (automation: AutomationView) => void;
}

/**
 * 装配自动化任务工具集。
 * @param port 存储端口（由 modules/chat 装配时注入 AutomationService）
 * @param defaultSessionId 当前会话 id：模型未显式指定 sessionId 时，任务默认绑定到发起它的会话，
 *   到点结果回灌进同一会话（对齐 task-tools 注入 sessionId 的做法）。缺省则不绑定、每次新建会话。
 * @param hooks 创建成功后的回调（用于锁本轮工具，§11 决策：会话工具场景只允许一次纯文本回复）。
 */
export function createAutomationTools(
    port: AutomationToolPort,
    defaultSessionId?: string,
    hooks?: AutomationToolHooks
) {
    return {
        CronCreate: tool({
            description: [
                '创建一个定时/周期自动化任务：到点后系统会无人值守地按 prompt 自动跑一轮并把结果存进会话。',
                '适合「每天早上汇总」「10 分钟后提醒我」「每周一整理」这类用户明确要求定时/周期执行的诉求。',
                '相对时间（after/every）由服务端按真实当前时间锚定，你只需给出秒数，不要自己换算成绝对时间。',
                '创建成功后本轮工具会被收起：请只用一句话确认任务已创建（标题与触发时间），不要再调用其它工具。'
            ].join(''),
            inputSchema: z.object({
                title: z.string().describe('任务标题，简短可读'),
                prompt: z.string().describe('到点要执行的完整指令，应自包含、可独立执行'),
                schedule: scheduleSchema,
                sessionId: z
                    .string()
                    .optional()
                    .describe('绑定到某会话续跑；缺省绑定当前会话，显式传空可改为每次新建会话')
            }),
            execute: async ({ sessionId, ...rest }) => {
                const automation = await port.create(
                    {
                        ...rest,
                        sessionId: sessionId ?? defaultSessionId
                    } as AutomationCreateRequest,
                    'tool'
                );
                // 通知本轮「已建任务」：runner 随即在后续 step 收走全部工具，只允许一次文本确认。
                hooks?.onCreated?.(automation);
                return { ok: true, automation };
            }
        }),

        CronList: tool({
            description: '列出已创建的自动化任务及其状态与下次运行时间。',
            inputSchema: z.object({
                filter: z.enum(['enabled', 'inactive', 'all']).optional().describe('筛选，缺省 all')
            }),
            execute: async ({ filter }) => {
                const automations = await port.list(filter);
                return { ok: true, automations };
            }
        }),

        CronUpdate: tool({
            description: '按 id 编辑自动化任务：改标题 / 指令 / 触发规则 / 启停。schedule 变更后下次运行时间会重算。',
            inputSchema: z.object({
                id: z.string().describe('任务 id'),
                title: z.string().optional(),
                prompt: z.string().optional(),
                schedule: scheduleSchema.optional(),
                enabled: z.boolean().optional()
            }),
            execute: async ({ id, ...patch }) => {
                const automation = await port.update(id, patch as AutomationUpdateRequest);
                return { ok: true, automation };
            }
        }),

        CronDelete: tool({
            description: '按 id 删除一个自动化任务。',
            inputSchema: z.object({ id: z.string().describe('任务 id') }),
            execute: async ({ id }) => {
                await port.delete(id);
                return { ok: true, id };
            }
        })
    };
}
