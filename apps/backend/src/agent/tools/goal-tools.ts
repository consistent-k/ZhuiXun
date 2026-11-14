import type { GoalView } from '@zhuixun/shared';
import { tool } from 'ai';
import { z } from 'zod';

/**
 * 自驱循环（Goal）工具 —— 让模型在同一会话里持续自我推进，直到目标达成或触顶。
 *
 * 只挂载在交互式 agent：无人值守/后台执行轮不挂，避免「自驱里再自驱」。
 */
export interface GoalToolPort {
    arm(sessionId: string, goal: string, maxRounds?: number): GoalView;
    disarm(sessionId: string): GoalView | null;
    get(sessionId: string): GoalView | null;
}

/**
 * 装配 Goal 工具集。
 * @param port GoalService
 * @param sessionId 当前会话 id：自驱必须绑定会话，缺省则不提供（工具会报错）。
 */
export function createGoalTools(port: GoalToolPort, sessionId?: string) {
    return {
        GoalArm: tool({
            description: [
                '为当前会话开启自驱循环：每轮结束后系统会自动回灌「继续推进」的提示，直到目标达成或达到轮数上限。',
                '适合用户明确说「你自己持续做，直到完成」「不用每步问我，做完再汇报」这类诉求。',
                '每轮都必须有明显的实际进展；目标要写成可判断是否完成的结果描述。',
                '目标达成时在回复里写 <goal_done> 标记以结束循环。'
            ].join(''),
            inputSchema: z.object({
                goal: z.string().describe('要持续达成的目标，写成可判定完成的描述'),
                maxRounds: z
                    .number()
                    .int()
                    .min(1)
                    .max(50)
                    .optional()
                    .describe('最多自动推进多少轮，缺省取应用设置（默认 5）')
            }),
            execute: async ({ goal, maxRounds }) => {
                if (!sessionId) return { ok: false, error: '当前没有可绑定的会话，无法开启自驱循环' };
                const view = port.arm(sessionId, goal, maxRounds);
                return { ok: true, goal: view };
            }
        }),

        GoalStatus: tool({
            description: '查看当前会话的自驱循环状态（是否开启、已推进轮数、是否触顶）。',
            inputSchema: z.object({}),
            execute: async () => {
                if (!sessionId) return { ok: false, error: '当前没有可绑定的会话' };
                const view = port.get(sessionId);
                return view ? { ok: true, goal: view } : { ok: true, goal: null };
            }
        }),

        GoalDisarm: tool({
            description: '停止当前会话的自驱循环。',
            inputSchema: z.object({}),
            execute: async () => {
                if (!sessionId) return { ok: false, error: '当前没有可绑定的会话' };
                const view = port.disarm(sessionId);
                return { ok: true, goal: view };
            }
        })
    };
}
