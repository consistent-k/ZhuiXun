/** 智能体表达风格（Persona）的前后端 HTTP 契约。 */
export type PersonaKind = 'builtin' | 'custom';

/** 单个风格的可展示定义；内置风格由后端代码提供，自定义风格落在 settings.json。 */
export interface PersonaView {
    id: string;
    name: string;
    description: string;
    /** 只影响表达的系统提示词片段；默认风格为空串。 */
    instruction: string;
    kind: PersonaKind;
    /** 自定义风格的更新时间；内置风格缺省。 */
    updatedAt?: number;
}

/** GET /api/personas 返回体。 */
export interface PersonaConfigView {
    /** 默认风格 id；无法解析时后端回落到 default。 */
    defaultId: string;
    items: PersonaView[];
}

/** 新建自定义风格。 */
export interface PersonaCreateInput {
    name: string;
    description?: string;
    instruction: string;
}

/** 更新自定义风格。 */
export type PersonaUpdateInput = Partial<PersonaCreateInput>;
