import type { AskUserQuestionOutput } from '@zhuixun/shared';
import { z } from 'zod';

const nonBlank = z.string().refine((value) => value.trim().length > 0, '不得为空白');

export const askUserQuestionInputSchema = z.strictObject({
    questions: z
        .array(
            z.strictObject({
                question: nonBlank.describe('完整、清楚且具体的问题。'),
                header: nonBlank.max(12).describe('1–12 字符的简短主题标签。'),
                options: z
                    .array(
                        z.strictObject({
                            label: nonBlank.describe('可独立理解的选项标签；同题不可重复。'),
                            description: nonBlank.describe('选项的含义或影响。'),
                            preview: z.string().optional().describe('可选的 Markdown、代码或文本示意预览，仅单选展示。')
                        })
                    )
                    .min(2)
                    .max(4)
                    .superRefine((options, ctx) => {
                        const labels = options.map((option) => option.label.trim());
                        if (new Set(labels).size !== labels.length) {
                            ctx.addIssue({ code: 'custom', message: '同题选项标签不得重复' });
                        }
                    }),
                multiSelect: z.boolean().optional().describe('是否多选，省略为 false；界面自动提供其他及自定义输入。')
            })
        )
        .min(1)
        .max(4)
});

export const askUserQuestionOutputSchema = z.strictObject({
    answers: z
        .array(
            z.strictObject({
                questionIndex: z.number().int().min(0).max(3),
                question: nonBlank,
                selectedOptions: z.array(nonBlank).max(4),
                customText: nonBlank.optional()
            })
        )
        .min(1)
        .max(4)
});

export class QuestionValidationError extends Error {
    constructor(
        readonly status: 400,
        message: string
    ) {
        super(message);
        this.name = 'QuestionValidationError';
    }
}

/** 只接受新版协议；规范化题序、选项顺序及自定义文字，绝不改写题干与 label。 */
export function validateQuestionAnswer(inputValue: unknown, outputValue: unknown): AskUserQuestionOutput {
    const input = askUserQuestionInputSchema.safeParse(inputValue);
    const output = askUserQuestionOutputSchema.safeParse(outputValue);
    if (!input.success || !output.success) throw new QuestionValidationError(400, '问题或答案格式不合法');
    const { questions } = input.data;
    const { answers } = output.data;
    if (answers.length !== questions.length || new Set(answers.map((a) => a.questionIndex)).size !== questions.length) {
        throw new QuestionValidationError(400, '答案必须完整且唯一地覆盖所有题目');
    }
    return {
        answers: questions.map((question, questionIndex) => {
            const answer = answers.find((a) => a.questionIndex === questionIndex);
            if (!answer || answer.question !== question.question)
                throw new QuestionValidationError(400, '答案题干不匹配');
            const selected = new Set(answer.selectedOptions);
            if (
                selected.size !== answer.selectedOptions.length ||
                [...selected].some((label) => !question.options.some((o) => o.label === label))
            ) {
                throw new QuestionValidationError(400, '答案含未知或重复选项');
            }
            const customText = answer.customText?.trim();
            if (
                question.multiSelect ? selected.size === 0 && !customText : selected.size + (customText ? 1 : 0) !== 1
            ) {
                throw new QuestionValidationError(400, '答案不满足单选或多选规则');
            }
            return {
                questionIndex,
                question: question.question,
                selectedOptions: question.options.filter((o) => selected.has(o.label)).map((o) => o.label),
                ...(customText ? { customText } : {})
            };
        })
    };
}

export type QuestionPart = Record<string, unknown> & { toolCallId: string };
export interface QuestionMessage {
    id: string;
    role: string;
    parts?: unknown[];
}

export function isQuestionPart(part: unknown): part is QuestionPart {
    if (!part || typeof part !== 'object') return false;
    const value = part as Record<string, unknown>;
    return (
        typeof value.toolCallId === 'string' &&
        (value.type === 'tool-askUserQuestion' ||
            (value.type === 'dynamic-tool' && value.toolName === 'askUserQuestion'))
    );
}

/** 普通保存、SDK 续跑与导入共用成对校验；答案直接来自消息，不依赖独立提交或旧格式迁移。 */
export function validateQuestionMessages(messages: QuestionMessage[]): void {
    const callIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const message of messages) {
        if (!message || typeof message.id !== 'string' || messageIds.has(message.id)) {
            throw new QuestionValidationError(400, '消息身份不合法或重复');
        }
        messageIds.add(message.id);
        for (const raw of message.parts ?? []) {
            if (!raw || typeof raw !== 'object') continue;
            const part = raw as Record<string, unknown>;
            const isQuestion =
                part.type === 'tool-askUserQuestion' ||
                (part.type === 'dynamic-tool' && part.toolName === 'askUserQuestion');
            if (!isQuestion) continue;
            if (
                !isQuestionPart(part) ||
                !part.toolCallId ||
                callIds.has(part.toolCallId) ||
                message.role !== 'assistant'
            ) {
                throw new QuestionValidationError(400, '问题调用身份不合法或重复');
            }
            callIds.add(part.toolCallId);
            // SDK 在输入流结束前只提供 DeepPartial；整单保存可保留草稿，但不能夹带答案。
            if (part.state === 'input-streaming' && part.output === undefined) continue;
            if (!askUserQuestionInputSchema.safeParse(part.input).success) {
                throw new QuestionValidationError(400, '问题必须使用完整新版格式');
            }
            if (part.state === 'output-available') {
                validateQuestionAnswer(part.input, part.output);
            } else if (!['input-available', 'output-error'].includes(String(part.state)) || part.output !== undefined) {
                throw new QuestionValidationError(400, '问题状态或答案不合法');
            }
        }
    }
}
