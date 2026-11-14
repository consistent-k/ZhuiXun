import fsp from 'node:fs/promises';
import path from 'node:path';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { resolveAllowedTools } from '@/agent/tools/binding';
import { findSkillMetadata } from '@/agent/tools/skill-lookup';
import { isSeedableSkillResource } from '@/agent/tools/skill-resources';
import type { SkillMetadata, SkillUpsertInput } from '@/modules/skills';
import type { SkillRegistry } from '@/modules/skills';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('SkillTool');

/** load_skill 解析技能 allowed-tools 时用到的候选工具池（内置 shell + 已注册 MCP）。 */
export interface SkillBindingPools {
    shellTools: ToolSet;
    /** 内置 Web 工具（WebFetch / WebSearch）；未开启 Web 能力时为空集。 */
    webTools: ToolSet;
    mcpTools: ToolSet;
}

export interface SkillToolOptions {
    /**
     * 是否挂载写类技能工具（create_skill / update_skill）。
     *
     * 桌面端 routed / progressive 传 true：这两个工具走 registry 的用户技能写入通道
     * （`~/.zhuixun/skills`），不依赖 shell cwd、也不受 `isProtectedWrite` 限制——
     * 否则模型只能自己在工作区里造目录，技能永远不会被 registry 扫到。
     * 渠道（无人值守、无审批 UI）与只读子 agent 保持 false，只给 load_skill / list_skills。
     */
    allowWrite?: boolean;
    /**
     * 技能成功加载后带着该技能「本轮新增可用」的工具集调用一次
     * （技能自带代码工具 + allowed-tools 解析命中的 shell/MCP 工具）。
     * 渐进式模式（createProgressiveAgent）用它把这些工具注入到本轮可调用的工具集里——
     * 否则 load_skill 只把工具**名字**回给模型，模型据此调用却会 "tool not found"。
     * 路由模式下工具已全量 eager 挂载，无需传入该回调。
     */
    onSkillLoaded?: (tools: ToolSet) => void;
    /**
     * 返回解析 allowed-tools 用的候选池。传入后才会把技能声明的
     * `Bash`/`Read`/`Write`/`mcp__*` 规则解析成真实工具。
     */
    getBindingPools?: () => Promise<SkillBindingPools>;
    /** 当前实际工具集，避免把未挂载的技能工具误报为可调用（渠道 / 子 agent 尤其如此）。 */
    getAvailableTools?: () => ToolSet;
    /**
     * 默认工作区模式下 shell 工具的工作目录（用户技能副本所在处，见 shell-tools seedSkillResources）。
     * 传入后 load_skill 对完整同步的用户技能返回工作区副本作为 directory；项目模式、渠道等不传。
     */
    workspaceDir?: string;
}

/**
 * 解析 load_skill 返回给模型的技能目录与资源清单。
 *
 * 工作区里存在与技能同名的副本时，若仍返回 `~/.zhuixun/skills/...`，模型会面对两份目录，
 * 常按 SKILL.md 的相对路径在 cwd 副本里找脚本（会话 0cef64d1 实例）；且 Bash 命令含 `.zhuixun`
 * 一律 ask。故副本完整时只给副本。逐个核对副本文件，缺任一文件（同步失败、shell 不可用等）
 * 都退回真实目录，不把不完整的副本交给模型。
 */
async function resolveSkillLocation(
    meta: SkillMetadata,
    files: string[],
    workspaceDir: string | undefined
): Promise<{ directory: string; files: string[]; inWorkspace: boolean }> {
    const origin = { directory: meta.dirPath, files, inWorkspace: false };
    if (!workspaceDir || meta.source !== 'user') return origin;
    const copyDir = path.join(workspaceDir, path.basename(meta.dirPath));
    const seeded = files.filter(isSeedableSkillResource);
    const present = await Promise.all(
        ['SKILL.md', ...seeded].map((file) =>
            fsp.access(path.join(copyDir, file)).then(
                () => true,
                () => false
            )
        )
    );
    return present.every(Boolean) ? { directory: copyDir, files: seeded, inWorkspace: true } : origin;
}

/**
 * create_skill 的字段定义：与前端「新建技能」表单 / `SkillUpsertInput` 一一对应，
 * 落盘后由 loader 序列化成带 YAML frontmatter 的 SKILL.md。
 */
const skillCreateFields = {
    name: z
        .string()
        .describe('技能 id（同时是目录名与 frontmatter.name）：kebab-case，仅小写字母/数字/连字符，且以字母开头'),
    displayName: z.string().optional().describe('展示名（如中文名）；留空时展示名称沿用 id'),
    description: z.string().describe('一句话说明这个技能做什么、什么时候该用它（会进技能目录）'),
    triggers: z.array(z.string()).optional().describe('触发词/典型说法，供路由参考'),
    systemPrompt: z
        .string()
        .describe('技能正文：load_skill 时以 instructions 工具结果返回的完整工作流程说明（即 SKILL.md 正文）'),
    allowedTools: z
        .array(z.string())
        .optional()
        .describe('声明式可用工具，如 Bash、Read、Write、mcp__server__tool；技能里用不到工具就省略'),
    disallowedTools: z.array(z.string()).optional().describe('从 allowedTools 中排除的工具规则')
};

/** update_skill 只覆盖显式传入的字段，其余保持原样（避免模型漏填把已有内容清空）。 */
const skillUpdateFields = {
    name: z.string().describe('要更新的技能 id（必须是 list_skills 里 editable=true 的用户技能）'),
    displayName: skillCreateFields.displayName,
    description: skillCreateFields.description.optional(),
    triggers: skillCreateFields.triggers,
    systemPrompt: skillCreateFields.systemPrompt.optional(),
    allowedTools: skillCreateFields.allowedTools,
    disallowedTools: skillCreateFields.disallowedTools
};

/** 去掉值为 undefined 的键，供 update_skill 做「局部合并」。 */
function definedFields<T extends object>(obj: T): Partial<T> {
    return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** 把 registry / store 抛出的写错误转成模型可读的提示（带 code 时补充下一步动作）。 */
function describeSkillWriteError(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'CONFLICT') return `${message}；如需改动请改用 update_skill`;
    return message;
}

/**
 * 技能元工具集。
 *
 * @param registry 技能注册表
 * @param options 见 {@link SkillToolOptions}
 */
export function createSkillTools(registry: SkillRegistry, options: SkillToolOptions = {}) {
    const { allowWrite, onSkillLoaded, getBindingPools, getAvailableTools, workspaceDir } = options;

    const metaTools = {
        load_skill: tool({
            description: '加载指定技能的完整指令和可用工具。根据用户意图选择合适的技能 ID 进行加载。',
            inputSchema: z.object({
                skillId: z.string().describe('要加载的技能 ID（取自 list_skills / 技能目录中列出的 id）')
            }),
            execute: async ({ skillId: requestedId }) => {
                log.info('load_skill 被调用', { skillId: requestedId });
                // 停用的技能不允许加载：否则模型仍能通过 load_skill 注入其 systemPrompt/行为，
                // 绕过前端「停用」。availableSkills 也只返回启用的，避免把停用 id 泄露给模型。
                // 与技能误调用修复共用查找：仅差大小写 / `_`↔`-` 且唯一命中已启用技能时也能加载，
                // 之后一律使用规范 id（meta.id），返回值里的 skillId 即正确写法。
                const meta = findSkillMetadata(registry, requestedId);
                const skillId = meta?.id ?? requestedId;
                if (meta && skillId !== requestedId) {
                    log.info('load_skill 技能 id 归一化命中', { requested: requestedId, skillId });
                }
                const enabledIds = registry
                    .listMetadata()
                    .filter((s) => !s.disabled)
                    .map((s) => s.id);
                if (!meta || meta.disabled) {
                    // 拒绝时回显模型传入的原名，不暴露停用技能的规范 id
                    log.warn('load_skill 拒绝', {
                        skillId: requestedId,
                        reason: meta ? '已停用' : '不存在',
                        available: enabledIds
                    });
                    return {
                        success: false,
                        error: meta ? `技能 ${requestedId} 已停用` : `技能 ${requestedId} 不存在`,
                        availableSkills: enabledIds
                    };
                }

                const skill = await registry.get(skillId);
                if (!skill) {
                    log.warn('load_skill 失败：技能加载失败', { skillId, available: enabledIds });
                    return {
                        success: false,
                        error: `技能 ${skillId} 加载失败`,
                        availableSkills: enabledIds
                    };
                }

                log.info('load_skill 成功', { skill: skill.name, tools: Object.keys(skill.tools || {}) });

                // 本轮该技能新增可用的工具 = 技能自带代码工具 + allowed-tools 解析命中的 shell/MCP 工具。
                // 解析 allowed-tools 需要候选池（shell + MCP），只有渐进式模式会传入 getBindingPools。
                // 名称冲突时技能自带代码工具优先（它做过名称归一等处理）。
                let extraTools: ToolSet = { ...(skill.tools || {}) };
                if (getBindingPools && skill.allowedTools && skill.allowedTools.length > 0) {
                    try {
                        const pools = await getBindingPools();
                        const bound = resolveAllowedTools(skill.allowedTools, skill.disallowedTools, pools);
                        extraTools = { ...bound, ...extraTools };
                    } catch (error) {
                        log.error('解析技能 allowed-tools 失败，本次仅注入技能自带工具', {
                            skillId,
                            err: error
                        });
                    }
                }

                const location = await resolveSkillLocation(
                    meta,
                    await registry.listResourceFiles(skillId),
                    workspaceDir
                );
                // 渐进模式下先接入工具，再以实际工具集核对；只读 agent 不能把未注入的工具报为可用。
                onSkillLoaded?.(extraTools);
                const currentTools = getAvailableTools?.();
                const availableTools = Object.keys(extraTools).filter((name) =>
                    currentTools ? Object.hasOwn(currentTools, name) : !!onSkillLoaded
                );
                // 无新增工具不等于无需工具：搜索类流程仍需已有 WebFetch。正文作为工具结果返回，
                // 不会改写 system instructions，故命名为 instructions；不能用空工具列表指引模型编造结果。
                const guidance = [
                    '按 instructions 执行技能流程；availableTools 仅列出本技能关联且本轮已可用的工具，不是本轮工具全集。',
                    '列表为空只表示没有额外提供工具，需要时仍应使用本轮已有的相关工具；不要为使用技能而调用无关工具。',
                    '技能 id 不是工具名。技能示例可能来自其他运行环境，工具名称和参数以本轮实际工具定义为准。',
                    ...(currentTools && Object.hasOwn(currentTools, 'WebFetch')
                        ? [
                              '本环境的网页读取工具名为 WebFetch；技能示例中的 web_fetch 应按 WebFetch 的实际参数定义调用。'
                          ]
                        : []),
                    'files 中的资源路径相对于 directory；仅在本轮具备相应工具且权限允许时按需读取。',
                    location.inWorkspace
                        ? 'directory 是该技能在当前工作目录下的副本，可在其中按说明运行脚本；不要修改其中文件，产出写成新文件。'
                        : '技能源目录保持只读。',
                    '资源清单不会自动执行脚本，也不授予额外权限。'
                ].join('\n');
                return {
                    success: true,
                    skillId: skill.id,
                    name: skill.name,
                    description: skill.description,
                    instructions: skill.systemPrompt,
                    directory: location.directory,
                    files: location.files,
                    availableTools,
                    guidance
                };
            }
        }),

        list_skills: tool({
            description: '列出所有可用技能及其描述，帮助判断应该使用哪个技能。',
            inputSchema: z.object({}),
            execute: async () => {
                log.info('list_skills 被调用');
                // 只返回启用的技能：停用的技能对模型完全不可见，避免它据此路由/加载
                const metadata = registry.listMetadata().filter((s) => !s.disabled);
                log.info('list_skills 返回启用技能', { count: metadata.length, skills: metadata.map((s) => s.id) });
                return {
                    skills: metadata.map((s) => ({
                        id: s.id,
                        name: s.name,
                        description: s.description,
                        triggers: s.triggers,
                        // update_skill 只能改用户技能；只读根（~/.agents 等）的技能标 editable=false
                        editable: s.editable
                    }))
                };
            }
        })
    };

    if (!allowWrite) return metaTools;

    return {
        ...metaTools,

        create_skill: tool({
            description: [
                '新建一个用户技能：把技能说明写入应用的用户技能根（默认 ~/.zhuixun/skills），并立即重扫注册表。',
                '用户要求「新建/创建一个技能」时必须用本工具，**不要**用 Write/Bash 在文件系统里拼技能目录',
                '——工作区里的技能文档只是参考副本，文件工具也无法写入应用数据目录。',
                '落盘后 list_skills 立即可见；要使用该技能需再调用 load_skill。'
            ].join(''),
            inputSchema: z.object(skillCreateFields),
            execute: async (input) => {
                log.info('create_skill 被调用', { name: input.name });
                if (!registry.hasUserDir()) {
                    return { success: false, error: '未配置用户技能目录，无法新建技能' };
                }
                try {
                    const payload: SkillUpsertInput = {
                        name: input.name,
                        displayName: input.displayName,
                        description: input.description,
                        triggers: input.triggers,
                        systemPrompt: input.systemPrompt,
                        allowedTools: input.allowedTools,
                        disallowedTools: input.disallowedTools
                    };
                    const meta = await registry.createUserSkill(payload);
                    log.info('create_skill 成功', { skillId: meta.id, dir: meta.dirPath });
                    return {
                        success: true,
                        skillId: meta.id,
                        path: meta.dirPath,
                        note: '已写入用户技能根并重扫，list_skills 立即可见。'
                    };
                } catch (error) {
                    log.warn('create_skill 失败', { name: input.name, err: error });
                    return { success: false, error: describeSkillWriteError(error) };
                }
            }
        }),

        update_skill: tool({
            description: [
                '更新一个已存在的用户技能：只覆盖传入的字段，未传的字段保持原样。',
                '内置/外部只读技能（list_skills 里 editable=false）不能用本工具修改。',
                '与 create_skill 一样走应用的用户技能通道，不要用 Write/Edit 直接改技能目录。'
            ].join(''),
            inputSchema: z.object(skillUpdateFields),
            execute: async (patch) => {
                log.info('update_skill 被调用', { skillId: patch.name });
                if (!registry.hasUserDir()) {
                    return { success: false, error: '未配置用户技能目录，无法更新技能' };
                }
                const meta = registry.getMetadataById(patch.name);
                if (!meta) {
                    return { success: false, error: `技能 ${patch.name} 不存在（可先 list_skills 确认 id）` };
                }
                if (meta.source !== 'user' || !meta.editable) {
                    return {
                        success: false,
                        error: `技能 ${patch.name} 来自只读技能根，不能修改；如需改动请用 create_skill 新建同 id 的用户技能`
                    };
                }
                try {
                    const current = await registry.getSkillSource(patch.name);
                    if (!current) {
                        return { success: false, error: `技能 ${patch.name} 的源文件读取失败，无法更新` };
                    }
                    // 局部合并：模型只需传要改的字段，漏传不会把已有 description/systemPrompt 清空
                    const merged: SkillUpsertInput = {
                        ...current,
                        ...(definedFields(patch) as Partial<SkillUpsertInput>),
                        name: patch.name
                    };
                    const updated = await registry.updateUserSkill(patch.name, merged);
                    log.info('update_skill 成功', { skillId: updated.id, dir: updated.dirPath });
                    return {
                        success: true,
                        skillId: updated.id,
                        path: updated.dirPath,
                        note: '已更新并重扫，list_skills / load_skill 立即可见新内容。'
                    };
                } catch (error) {
                    log.warn('update_skill 失败', { skillId: patch.name, err: error });
                    return { success: false, error: describeSkillWriteError(error) };
                }
            }
        })
    };
}
