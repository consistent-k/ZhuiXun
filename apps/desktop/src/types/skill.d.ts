export type SkillSource = 'builtin' | 'user';

export interface LoadedSkill {
    id: string;
    name: string;
    description: string;
    tools: ToolDefinition[];
    /** 技能来源：builtin=内置只读，user=用户自建可编辑 */
    source: SkillSource;
    /** 是否可编辑/删除（仅 user 技能为 true） */
    editable: boolean;
    /** 是否已停用 */
    disabled: boolean;
}

/** GET /api/skills 列表项（后端原始形态） */
export interface SkillListItem {
    id: string;
    name: string;
    description: string;
    source: SkillSource;
    editable: boolean;
    disabled: boolean;
    tools: Array<{ name: string; description: string }>;
}

/** GET /api/skills/:id 详情（含 systemPrompt 原文，供编辑回填） */
export interface SkillDetail {
    id: string;
    source: SkillSource;
    editable: boolean;
    displayName?: string;
    description: string;
    triggers?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    systemPrompt: string;
    tools: Array<{ name: string; description: string }>;
}

/** 新增/编辑用户技能的请求体 */
export interface SkillUpsertBody {
    name: string;
    displayName?: string;
    description: string;
    triggers?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    systemPrompt: string;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
