import type {
    AskUserQuestion,
    AskUserQuestionAnswer,
    AskUserQuestionInput,
    AskUserQuestionOption,
    AskUserQuestionOutput
} from '@zhuixun/shared';

export interface QuestionAnswerValues {
    selectedOptionIndexes: number[];
    otherSelected: boolean;
    customText: string;
}

export interface QuestionFormValues {
    answers: QuestionAnswerValues[];
}

/** 仅在会话内存中保留未提交草稿，提交成功后清除。 */
export interface QuestionDraft {
    inputFingerprint: string;
    currentQuestion: number;
    values: QuestionFormValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}

function isNonblank(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** 运行时仅接受新版完整协议，半截输入与旧形状不得生成可提交表单。 */
export function parseQuestionInput(value: unknown): AskUserQuestionInput | null {
    if (!isRecord(value) || !hasOnlyKeys(value, ['questions']) || !Array.isArray(value.questions)) return null;
    if (value.questions.length < 1 || value.questions.length > 4) return null;

    const questions: AskUserQuestion[] = [];
    for (const question of value.questions) {
        if (
            !isRecord(question) ||
            !hasOnlyKeys(question, ['question', 'header', 'options', 'multiSelect']) ||
            !isNonblank(question.question) ||
            !isNonblank(question.header) ||
            question.header.length > 12 ||
            (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') ||
            !Array.isArray(question.options) ||
            question.options.length < 2 ||
            question.options.length > 4
        ) {
            return null;
        }
        const labels = new Set<string>();
        const options: AskUserQuestionOption[] = [];
        for (const option of question.options) {
            if (
                !isRecord(option) ||
                !hasOnlyKeys(option, ['label', 'description', 'preview']) ||
                !isNonblank(option.label) ||
                !isNonblank(option.description) ||
                (option.preview !== undefined && typeof option.preview !== 'string') ||
                labels.has(option.label.trim())
            ) {
                return null;
            }
            labels.add(option.label.trim());
            options.push({
                label: option.label,
                description: option.description,
                ...(option.preview !== undefined ? { preview: option.preview } : {})
            });
        }
        questions.push({
            question: question.question,
            header: question.header,
            options,
            ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {})
        });
    }
    return { questions };
}

export function getInputFingerprint(input: AskUserQuestionInput): string {
    return JSON.stringify(
        input.questions.map((q) => [
            q.question,
            q.header,
            q.options.map((o) => [o.label, o.description, o.preview ?? null]),
            q.multiSelect ?? false
        ])
    );
}

export function createEmptyValues(input: AskUserQuestionInput): QuestionFormValues {
    return {
        answers: input.questions.map(() => ({ selectedOptionIndexes: [], otherSelected: false, customText: '' }))
    };
}

function isAnswerValues(question: AskUserQuestion, value: unknown): value is QuestionAnswerValues {
    if (
        !isRecord(value) ||
        !Array.isArray(value.selectedOptionIndexes) ||
        typeof value.otherSelected !== 'boolean' ||
        typeof value.customText !== 'string'
    ) {
        return false;
    }
    const indexes = value.selectedOptionIndexes;
    return (
        indexes.every((index) => Number.isInteger(index) && index >= 0 && index < question.options.length) &&
        new Set(indexes).size === indexes.length &&
        (question.multiSelect === true || (indexes.length <= 1 && !(value.otherSelected && indexes.length > 0)))
    );
}

export function getAnswerError(question: AskUserQuestion, value: unknown): string | null {
    if (!isAnswerValues(question, value)) return '答案无效，请重新选择';
    if (value.otherSelected && !value.customText.trim()) return '请填写其他答案，不能仅输入空白';
    if (!value.otherSelected && value.selectedOptionIndexes.length === 0) {
        return question.multiSelect ? '请至少选择一项或填写其他答案' : '请选择一项或填写其他答案';
    }
    return null;
}

/** 使用独立标识处理自动 Other，真实 label 为「其他」或含逗号时也不会混淆。 */
export function updateQuestionSelection(
    question: AskUserQuestion,
    value: QuestionAnswerValues,
    choice: number | 'other',
    checked = true
): QuestionAnswerValues {
    if (choice !== 'other' && (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length)) {
        return value;
    }
    if (!question.multiSelect) {
        return {
            ...value,
            selectedOptionIndexes: choice === 'other' || !checked ? [] : [choice],
            otherSelected: choice === 'other' && checked
        };
    }
    if (choice === 'other') return { ...value, otherSelected: checked };
    const selected = new Set(value.selectedOptionIndexes);
    if (checked) selected.add(choice);
    else selected.delete(choice);
    return { ...value, selectedOptionIndexes: [...selected].sort((a, b) => a - b) };
}

/** 统一按题目及原始选项顺序输出；只修剪自定义文字，不改写原题或 label。 */
export function buildQuestionOutput(
    input: AskUserQuestionInput,
    values: QuestionFormValues
): AskUserQuestionOutput | null {
    if (!Array.isArray(values?.answers) || values.answers.length !== input.questions.length) return null;
    const answers: AskUserQuestionAnswer[] = [];
    for (const [questionIndex, question] of input.questions.entries()) {
        const value = values.answers[questionIndex];
        if (getAnswerError(question, value)) return null;
        const selected = new Set(value.selectedOptionIndexes);
        answers.push({
            questionIndex,
            question: question.question,
            selectedOptions: question.options.filter((_, index) => selected.has(index)).map((option) => option.label),
            ...(value.otherSelected ? { customText: value.customText.trim() } : {})
        });
    }
    return { answers };
}

/** 新版结果必须与输入完整成对匹配；不接受旧 selectedOption 或缺题结果。 */
export function parseQuestionOutput(input: AskUserQuestionInput, value: unknown): AskUserQuestionOutput | null {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ['answers']) ||
        !Array.isArray(value.answers) ||
        value.answers.length !== input.questions.length
    ) {
        return null;
    }
    const values = createEmptyValues(input);
    const seen = new Set<number>();
    for (const answer of value.answers) {
        if (
            !isRecord(answer) ||
            !hasOnlyKeys(answer, ['questionIndex', 'question', 'selectedOptions', 'customText']) ||
            typeof answer.questionIndex !== 'number' ||
            !Number.isInteger(answer.questionIndex) ||
            answer.questionIndex < 0 ||
            answer.questionIndex >= input.questions.length ||
            seen.has(answer.questionIndex) ||
            !Array.isArray(answer.selectedOptions) ||
            !answer.selectedOptions.every((label) => typeof label === 'string') ||
            new Set(answer.selectedOptions).size !== answer.selectedOptions.length ||
            (answer.customText !== undefined && !isNonblank(answer.customText))
        ) {
            return null;
        }
        const question = input.questions[answer.questionIndex];
        if (answer.question !== question.question) return null;
        const indexes = answer.selectedOptions.map((label) =>
            question.options.findIndex((option) => option.label === label)
        );
        if (indexes.includes(-1)) return null;
        seen.add(answer.questionIndex);
        values.answers[answer.questionIndex] = {
            selectedOptionIndexes: indexes,
            otherSelected: answer.customText !== undefined,
            customText: typeof answer.customText === 'string' ? answer.customText : ''
        };
    }
    return buildQuestionOutput(input, values);
}

/** 输入变化直接弃用旧草稿；同一调用重挂载则恢复答案与题号，不因切题重新初始化。 */
export function restoreQuestionDraft(input: AskUserQuestionInput, draft?: QuestionDraft): QuestionDraft {
    const inputFingerprint = getInputFingerprint(input);
    const usable =
        draft?.inputFingerprint === inputFingerprint &&
        Number.isInteger(draft.currentQuestion) &&
        draft.currentQuestion >= 0 &&
        draft.currentQuestion < input.questions.length &&
        Array.isArray(draft.values?.answers) &&
        draft.values.answers.length === input.questions.length &&
        draft.values.answers.every((answer, index) => isAnswerValues(input.questions[index], answer));
    if (!usable) return { inputFingerprint, currentQuestion: 0, values: createEmptyValues(input) };
    return {
        inputFingerprint,
        currentQuestion: draft.currentQuestion,
        values: {
            answers: draft.values.answers.map((answer) => ({
                ...answer,
                selectedOptionIndexes: [...answer.selectedOptionIndexes]
            }))
        }
    };
}
