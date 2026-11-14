import type { PersonaView } from '@zhuixun/shared';

/** 默认风格：不注入额外文本，保持升级前的回答行为。 */
export const DEFAULT_PERSONA_ID = 'default';

/** 内置风格只提供表达层约束，不绑定工具、权限或具体结论。 */
export const BUILTIN_PERSONAS: readonly PersonaView[] = [
    {
        id: DEFAULT_PERSONA_ID,
        name: '标准',
        description: '保持 追寻 现有的回答方式',
        instruction: '',
        kind: 'builtin'
    },
    {
        id: 'evidence',
        name: '循证严谨',
        description: '结论先行，突出依据、不确定性和风险',
        instruction: [
            '默认结论先行，先给判断与处理建议，再说明关键依据。',
            '关键判断要区分一手资料、推断与经验判断，并明确不确定性。',
            '不省略风险与需要复核的环节。'
        ].join('\n'),
        kind: 'builtin'
    },
    {
        id: 'concise',
        name: '简明高效',
        description: '适合快速阅读',
        instruction: [
            '默认用 1~3 个要点直答，先给最重要结论。',
            '只展开用户追问的部分，减少寒暄、重复和教科书式背景。',
            '必要的安全提示仍要保留，不因简洁而省略。'
        ].join('\n'),
        kind: 'builtin'
    }
];
