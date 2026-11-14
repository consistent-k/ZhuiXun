import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from 'ai';

import { createLogger } from '@/platform/logging/index';

import { findSkillMetadata, normalizeSkillName, type SkillLookupRegistry } from './skill-lookup';

const log = createLogger('SkillCallRepair');

/**
 * 模型偶尔会把 catalog 中的技能 id 当工具名。仅修复精确匹配、或仅差大小写 / `_`-`-` 且唯一命中的已启用技能，
 * 交回 SDK 执行 load_skill，保留正常审批与 hooks；不直接执行技能、不猜测其他未知工具。
 */
export function createSkillCallRepair(registry: SkillLookupRegistry): ToolCallRepairFunction<ToolSet> {
    return async ({ toolCall, tools, error }) => {
        if (
            !NoSuchToolError.isInstance(error) ||
            toolCall.providerExecuted ||
            !Object.hasOwn(tools, 'load_skill') ||
            Object.hasOwn(tools, toolCall.toolName)
        ) {
            return null;
        }
        const meta = findSkillMetadata(registry, toolCall.toolName);
        // 停用技能不修复：交给模型看到 NoSuchTool，而不是绕过「停用」去加载；
        // 改写目标必须与原工具名归一化相同，防止 registry 返回的元数据与查询名不一致时改写到别的技能
        if (!meta || meta.disabled || normalizeSkillName(meta.id) !== normalizeSkillName(toolCall.toolName)) {
            return null;
        }

        log.info('技能 id 被误作工具名，修复为 load_skill', {
            skillId: meta.id,
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId
        });
        return {
            ...toolCall,
            toolName: 'load_skill',
            input: JSON.stringify({ skillId: meta.id })
        };
    };
}
