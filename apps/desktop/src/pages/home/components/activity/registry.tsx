import type { ToolLabelInfo } from '../tool-label-context';

import { stripMcpServerPrefix } from './format';
import type { ToolItem } from './model';
import type { ToolPresentation, ToolPresenter } from './presentation';
import { bashPresentation } from './presenters/BashPresenter';
import { editPresentation } from './presenters/EditPresenter';
import { genericPresentation } from './presenters/GenericPresenter';
import { lsPresentation } from './presenters/LsPresenter';
import { readPresentation } from './presenters/ReadPresenter';
import { globPresentation, grepPresentation } from './presenters/SearchPresenter';
import { memoryPresentation, skillPresentation } from './presenters/SimplePresenter';
import { taskPresentation } from './presenters/TaskPresenter';
import { webFetchPresentation } from './presenters/WebFetchPresenter';
import { writePresentation } from './presenters/WritePresenter';

/** 内置工具名 → 展示名；审批卡、兜底摘要共用，不再各自维护 switch */
const BUILTIN_LABELS: Record<string, string> = {
    Bash: '执行命令',
    Read: '读取文件',
    Write: '写入文件',
    Edit: '编辑文件',
    Grep: '检索内容',
    Glob: '查找文件',
    LS: '列出目录',
    WebFetch: '读取网页',
    Task: '子任务',
    read_memory: '读取记忆',
    write_memory: '保存记忆',
    delete_memory: '删除记忆',
    load_skill: '加载技能',
    list_skills: '查看技能列表',
    create_skill: '新建技能',
    update_skill: '更新技能',
    TaskCreate: '创建任务清单',
    TaskUpdate: '更新任务',
    TaskList: '查看任务清单',
    CronCreate: '创建定时任务',
    CronUpdate: '更新定时任务',
    CronDelete: '删除定时任务',
    CronList: '查看定时任务',
    JobStart: '启动后台任务',
    JobList: '查看后台任务',
    JobStatus: '查看后台任务状态',
    JobCancel: '取消后台任务',
    GoalArm: '开启自驱循环',
    GoalStatus: '查看自驱状态',
    GoalDisarm: '停止自驱循环'
};

const BUILTIN_PRESENTERS: Record<string, ToolPresenter> = {
    Bash: bashPresentation,
    Read: readPresentation,
    Write: writePresentation,
    Edit: editPresentation,
    Grep: grepPresentation,
    Glob: globPresentation,
    LS: lsPresentation,
    WebFetch: webFetchPresentation,
    Task: taskPresentation,
    read_memory: memoryPresentation,
    write_memory: memoryPresentation,
    delete_memory: memoryPresentation,
    load_skill: skillPresentation,
    list_skills: skillPresentation,
    create_skill: skillPresentation,
    update_skill: skillPresentation
};

function mcpLabel(toolName: string): string | null {
    const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
    return match ? `${match[1]} · ${match[2]}` : null;
}

/** 工具名 → 人话展示名；审批卡与兜底卡片共用 */
export function toolDisplayLabel(toolName: string, labels: Record<string, ToolLabelInfo> = {}): string {
    const legacyMcp = mcpLabel(toolName);
    if (legacyMcp) return legacyMcp;
    const skill = labels[toolName];
    if (skill?.source === 'mcp') {
        return `${skill.skillName} · ${stripMcpServerPrefix(toolName, skill.skillName)}`;
    }
    return BUILTIN_LABELS[toolName] ?? skill?.label ?? toolName;
}

/**
 * 解析工具展示描述。
 *
 * 顺序：内置 presenter → 技能工具（用 /api/skills 的 label 做副标题）→ MCP/未知兜底。
 * MCP 工具名由后端注册为 `<sanitizedServer>_<sanitizedTool>`，展示时还原为 `server · tool`；
 * 未知工具永远有 JSON 兜底，不会因为新增工具而退化成“只有名字的空白卡”。
 */
export function resolvePresentation(item: ToolItem, labels: Record<string, ToolLabelInfo> = {}): ToolPresentation {
    const builtin = BUILTIN_PRESENTERS[item.toolName];
    if (builtin) {
        const presentation = builtin(item);
        const skill = labels[item.toolName];
        if (!skill) return presentation;
        return skill.source === 'mcp'
            ? { ...presentation, sourceLabel: 'MCP', secondary: presentation.secondary ?? skill.label }
            : { ...presentation, sourceLabel: '技能工具', secondary: presentation.secondary ?? skill.label };
    }

    const skill = labels[item.toolName];
    if (skill) {
        const generic = genericPresentation(item);
        if (skill.source === 'mcp') {
            return {
                ...generic,
                kindLabel: `${skill.skillName} · ${stripMcpServerPrefix(item.toolName, skill.skillName)}`,
                secondary: generic.secondary ?? skill.label,
                sourceLabel: 'MCP'
            };
        }
        return {
            ...generic,
            kindLabel: '技能',
            primary: toolDisplayLabel(item.toolName, labels),
            secondary: skill.label,
            sourceLabel: '技能工具'
        };
    }

    return genericPresentation(item);
}
