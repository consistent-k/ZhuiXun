import { tool } from 'ai';

import { askUserQuestionInputSchema, askUserQuestionOutputSchema } from './question-validation';

/** 客户端工具：前端以 addToolOutput 回填整组答案并自动续跑，答案随既有会话流程保存。 */
export function createInteractionTools() {
    return {
        askUserQuestion: tool({
            description: [
                '向用户提出一组 1–4 道问题，通过卡片收集单选、多选或自定义回答。',
                '需要澄清影响结果的关键需求、了解必要偏好、选择方案，或开展有候选答案的交互式测评、问卷、练习时使用。用户已要求开始或“直接问我”时，直接提出第一组问题，不再确认是否开始，也不要求用户先提供测评结论。',
                '彼此独立的问题可合并为一次调用；依赖前题答案的问题分次调用。调用后等待用户提交，不要在同一回复中继续依赖答案的任务、重复列出题目，或推断用户尚未提交的答案。不要仅在正文列出 A/B 选项代替调用。',
                '每题提供 question、1–12 字符的 header、2–4 个含 label 和 description 的选项；multiSelect 省略为 false。',
                '界面自动提供“其他”和自定义文字输入，不要手动添加 Other 占位选项。单选自定义与预设项互斥，多选可并存。',
                'preview 可提供 Markdown、代码或文本示意，仅单选展示；只在比较具体内容或布局有帮助时提供，不为每个选项机械生成预览。',
                '全部题目一起提交。工具返回的 answers 是用户通过卡片提交的回答，按 questionIndex 对应原题，读取 selectedOptions 和 customText 后继续任务。结果为结构化 JSON 是正常行为，不要要求用户在正文重复回答。自定义回答按完整语义处理，不能静默套用预设项评分。',
                '方案确有推荐时可把推荐项放首位并标注；测评、偏好调查和练习题不标推荐或暗示答案。不要替用户作答。',
                '能自行查证的信息先查证，有合理默认的非关键细节直接推进，不重复询问已明确信息，不为已授权步骤反复确认。',
                '无候选项的纯开放问答、文件收集，或用户明确要求纯文本、可复制或打印的完整题单、答案解析时使用普通回复。仅要求“一次问完”且符合数量约束时，可合并调用本工具；超出约束时说明并分组提问。不要用本工具代替工具执行审批。'
            ].join('\n'),
            inputSchema: askUserQuestionInputSchema,
            outputSchema: askUserQuestionOutputSchema
            // 故意无 execute / needsApproval：等待桌面卡片提交真实用户答案。
        })
    };
}
