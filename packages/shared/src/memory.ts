/** 记忆作用域：global=用户个人长期画像（全局单库）；project=按项目隔离的专属事实。 */
export type MemoryScope = 'global' | 'project';

/** 记忆类型：user=用户是谁；feedback=对工作方式的纠正/确认；project=在做的事；reference=外部资源指针。 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** 单条记忆（一个事实一文件）。 */
export interface MemoryRecord {
    /** kebab-case slug，等于文件名去掉 .md，也是去重键 */
    name: string;
    type: MemoryType;
    /** 一行摘要，用于召回相关性判定与列表展示 */
    description: string;
    /** 正文（不含 frontmatter） */
    content: string;
    /** 最近更新时间（ISO） */
    updatedAt: string;
    /** 写入时所属会话（溯源，可空） */
    originSessionId?: string;
}

/** 清单项：只读 frontmatter，不含正文，供召回选择器与设置页列表。 */
export interface MemoryManifestItem {
    name: string;
    type?: MemoryType;
    description?: string;
    /** ISO；frontmatter 缺失时回落文件 mtime */
    updatedAt: string;
    mtimeMs: number;
}

/** 设置页某层总览（GET /api/memory/overview 返回体）。 */
export interface MemoryOverview {
    /** 全局唯一开关 */
    enabled: boolean;
    /** 每轮后自动沉淀 */
    autoExtract: boolean;
    /** 周期自动整理 */
    autoDream: boolean;
    scope: MemoryScope;
    projectId?: string;
    /** MEMORY.md 索引正文 */
    index: string;
    items: MemoryManifestItem[];
}

/** 有项目层记忆的项目摘要（设置页项目选择器）。 */
export interface MemoryProjectSummary {
    projectId: string;
    label: string;
    count: number;
    updatedAt?: string;
}
