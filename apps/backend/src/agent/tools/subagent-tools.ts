import { ToolLoopAgent, stepCountIs, tool, type ToolLoopAgentSettings, type ToolSet } from 'ai';
import { z } from 'zod';

import { buildSubagentInstructions } from '@/agent/context/prompts';
import { createModel } from '@/agent/model/provider';
import type { ToolApprovalFn } from '@/agent/tools/approval-pipeline';
import { createSkillCallRepair } from '@/agent/tools/skill-call-repair';
import { createSkillTools } from '@/agent/tools/skill-tools';
import type { ResolvedModel } from '@/config/types';
import type { SkillRegistry } from '@/modules/skills';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('Subagent');

/** 子 agent 工具循环最大步数：封顶成本、防绕圈（v1 同主模型）。 */
const SUBAGENT_MAX_STEPS = 25;

/** 传给子 agent 的只读工具名（从主 agent 已构建的 shell 工具集里取子集）。 */
const READ_ONLY_SHELL = ['Read', 'Grep', 'Glob', 'LS'];

export interface SubagentContext {
    registry: SkillRegistry;
    modelConfig: ResolvedModel;
    /** 主 agent 已构建的 shell 工具集，取其只读子集给子 agent（共用工作目录语义）。 */
    shellTools: ToolSet;
    sessionId?: string;
    /** 审批函数（装配点按权限策略构建，无确认 UI：ask 一律拒绝）；缺省不审批。 */
    toolApproval?: ToolApprovalFn;
}

/**
 * 子 Agent / 任务分发工具（Task）。
 * 把一项只读调查委派给 headless 嵌套 ToolLoopAgent（只读 explorer），运行到完成后仅把最终文本结论
 * 作为工具结果回传父 agent——子任务中间步骤不进入父会话上下文，这是节省父上下文的核心收益。
 *
 * v1 约束（见 tech-design §4.2）：
 * - 只读工具集（Read/Grep/Glob/LS + 只读技能元工具），无 Bash/Write/Edit/交互/记忆，故无需审批 UI；
 *   但仍过同一套声明式策略（如密钥文件 Read deny），防止借子任务绕过。
 * - 深度=1：子 agent 不获得 Task，禁止递归派发。
 * - 预算护栏：stepCountIs(SUBAGENT_MAX_STEPS) 封顶；v1 同主模型。
 * - v1 不挂 MCP（「只读 MCP」无可靠判定），本地只读调查足够；MCP 子任务延后。
 */
export function createSubagentTools(ctx: SubagentContext): ToolSet {
    return {
        Task: tool({
            description: [
                '把一项【只读调查】委派给子 agent 隔离执行，适合：大范围检索定位、跨多文件调查、',
                '需读很多内容但只要一个结论的场景。子任务只读（不改文件、不执行命令），完成后返回简洁结论。',
                '不要用它做修改类操作；需要写文件/执行命令请自己用 Edit/Write/Bash。'
            ].join(''),
            inputSchema: z.object({
                description: z.string().describe('子任务简述（便于展示），如「检索鉴权中间件」'),
                prompt: z.string().describe('交给子 agent 的完整调查任务描述；应自包含、可独立执行'),
                subagent_type: z.enum(['explorer']).optional().describe('子 agent 类型，当前仅 explorer（只读调查）')
            }),
            // APPEND_EXECUTE
            execute: async ({ description, prompt }) => {
                const model = createModel(ctx.modelConfig);
                const readOnly: ToolSet = {};
                for (const name of READ_ONLY_SHELL) {
                    const t = ctx.shellTools[name];
                    if (t) readOnly[name] = t;
                }
                // 只读技能元工具（list_skills / load_skill 无回调 = 只返回说明、不注入工具）
                const metaTools = createSkillTools(ctx.registry, { getAvailableTools: () => tools }) as ToolSet;
                const tools: ToolSet = { ...metaTools, ...readOnly };
                log.info('派发子 agent 任务', { description, sessionId: ctx.sessionId, tools: Object.keys(tools) });
                try {
                    const agent = new ToolLoopAgent({
                        model,
                        instructions: buildSubagentInstructions(ctx.registry.getCatalog()),
                        tools,
                        repairToolCall: createSkillCallRepair(ctx.registry),
                        stopWhen: stepCountIs(SUBAGENT_MAX_STEPS),
                        ...(ctx.toolApproval
                            ? { toolApproval: ctx.toolApproval as unknown as ToolLoopAgentSettings['toolApproval'] }
                            : {})
                    });
                    const result = await agent.generate({ prompt });
                    return { description, result: result.text };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    log.error('子 agent 执行失败', { description, err: error });
                    return { description, error: `子任务执行失败：${message}` };
                }
            }
        })
    };
}
