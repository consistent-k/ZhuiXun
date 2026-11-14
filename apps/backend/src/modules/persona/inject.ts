import { resolvePersona } from './service';

/**
 * 构建风格提示词段。
 * 默认风格或空指令返回 null；段落内显式声明它只影响表达，避免覆盖身份、安全、项目与记忆。
 */
export function buildPersonaSection(id?: string): string | null {
    const persona = resolvePersona(id);
    const instruction = persona.instruction.trim();
    if (!instruction) return null;
    return [
        '## 表达风格',
        '以下内容只影响表达方式（语气、结构、详略、术语解释程度），不改变事实、安全提示、工具能力与审批规则，也不覆盖项目要求、用户记忆或用户本轮的明确指令；发生冲突时，以后者为准。',
        '不要把本段风格本身写入记忆。',
        '',
        '<zhuixun-persona-style>',
        instruction,
        '</zhuixun-persona-style>'
    ].join('\n');
}
