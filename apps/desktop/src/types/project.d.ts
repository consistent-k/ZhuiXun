/** 项目根目录：一个项目可挂多个本地目录，其一为 primary（即会话 shell 的 cwd） */
export interface ProjectRoot {
    /** 绝对路径 */
    path: string;
    /** 是否主根（有且仅一个）；缺省视为非主根 */
    primary?: boolean;
}

/** 项目列表元信息（不含 instructions 等重字段，供侧栏渲染） */
export interface ProjectMeta {
    id: string;
    name: string;
    /** 展示用图标（emoji 或 antd icon key） */
    icon?: string;
    /** 展示用颜色 */
    color?: string;
    /** 是否归档 */
    archived?: boolean;
    /** 工作目录集合（primary 根作为会话 Bash/Read/Write 的 cwd，其余为附加根） */
    roots?: ProjectRoot[];
    /** 是否信任本项目目录：开启后其任一根范围内的安全命令/写入在对话时自动放行 */
    trusted?: boolean;
    /** 软删除标记（在回收站中可恢复或彻底删除） */
    deleted?: boolean;
    /** 软删除时间戳（ms） */
    deletedAt?: number;
    createdAt: number;
    updatedAt: number;
}

/** 项目全量（含指令与技能集，供设置页编辑回填） */
export interface SavedProject extends ProjectMeta {
    version: number;
    /** 项目级指令：该项目内所有会话的 systemPrompt 都会带上 */
    instructions?: string;
    /** 新会话默认技能 id */
    defaultSkillId?: string;
    /** 路由模式下限定启用的技能 id 集合；为空表示不限定 */
    skillPreset?: string[];
}

/** 创建/更新项目入参 */
export interface ProjectUpsertInput {
    name: string;
    icon?: string;
    color?: string;
    archived?: boolean;
    instructions?: string;
    defaultSkillId?: string;
    skillPreset?: string[];
    /** 工作目录集合；传入即整体覆盖（传 [] 表示清空） */
    roots?: ProjectRoot[];
    /** 是否信任本项目目录 */
    trusted?: boolean;
}
