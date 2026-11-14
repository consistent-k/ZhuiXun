import type { AskUserQuestionInput } from '@zhuixun/shared';
import { describe, expect, it } from 'vitest';

import {
    buildQuestionOutput,
    createEmptyValues,
    getAnswerError,
    getInputFingerprint,
    parseQuestionInput,
    parseQuestionOutput,
    restoreQuestionDraft,
    updateQuestionSelection
} from '../../../desktop/src/pages/home/components/AskQuestionCard/model';

function fixture(): AskUserQuestionInput {
    return {
        questions: [
            {
                question: '选择一种输出形式？',
                header: '输出形式',
                options: [
                    { label: ' 表格 ', description: '保留原始标签空格', preview: '| A | B |' },
                    { label: '其他', description: '真实预设标签也可以叫其他' }
                ]
            },
            {
                question: '希望包含哪些内容？',
                header: '内容',
                multiSelect: true,
                options: [
                    { label: '整理,归档', description: '含逗号的单个标签' },
                    { label: '复盘', description: '复盘建议', preview: '多选不展示预览' }
                ]
            }
        ]
    };
}

function filledValues(input = fixture()) {
    const values = createEmptyValues(input);
    values.answers[0].selectedOptionIndexes = [0];
    values.answers[1].selectedOptionIndexes = [1, 0];
    return values;
}

describe('AskQuestionCard strict input parsing', () => {
    it('accepts the 1–4 question and 2–4 option boundaries without rewriting strings', () => {
        const input = fixture();
        expect(parseQuestionInput(input)).toEqual(input);
        const question = input.questions[0];
        expect(parseQuestionInput({ questions: [question] })).toEqual({ questions: [question] });
        const fourOptions = {
            ...question,
            options: [...question.options, { label: 'C', description: 'C' }, { label: 'D', description: 'D' }]
        };
        expect(parseQuestionInput({ questions: Array.from({ length: 4 }, () => fourOptions) })?.questions).toHaveLength(
            4
        );
    });

    it.each([
        undefined,
        null,
        { question: '旧问题', options: ['A', 'B'] },
        { questions: [] },
        { questions: Array.from({ length: 5 }, () => fixture().questions[0]) },
        { questions: [{ ...fixture().questions[0], header: '1234567890123' }] },
        { questions: [{ ...fixture().questions[0], header: ' ' }] },
        { questions: [{ ...fixture().questions[0], question: '\n ' }] },
        { questions: [{ ...fixture().questions[0], options: [{ label: 'A', description: 'A' }] }] },
        {
            questions: [
                {
                    ...fixture().questions[0],
                    options: Array.from({ length: 5 }, (_, i) => ({ label: `${i}`, description: 'A' }))
                }
            ]
        },
        {
            questions: [
                {
                    ...fixture().questions[0],
                    options: [
                        { label: 'A', description: 'A' },
                        { label: ' A ', description: 'B' }
                    ]
                }
            ]
        },
        {
            questions: [
                {
                    ...fixture().questions[0],
                    options: [
                        { label: ' ', description: 'A' },
                        { label: 'B', description: 'B' }
                    ]
                }
            ]
        },
        {
            questions: [
                {
                    ...fixture().questions[0],
                    options: [
                        { label: 'A', description: '' },
                        { label: 'B', description: 'B' }
                    ]
                }
            ]
        },
        {
            questions: [
                {
                    ...fixture().questions[0],
                    options: [
                        { label: 'A', description: 'A', preview: null },
                        { label: 'B', description: 'B' }
                    ]
                }
            ]
        },
        { questions: [{ ...fixture().questions[0], multiSelect: 'true' }] },
        { questions: [{ ...fixture().questions[0], options: ['A', 'B'] }] },
        { questions: [fixture().questions[0]], answers: {} },
        { questions: [{ ...fixture().questions[0], unexpected: true }] }
    ])('rejects incomplete, malformed, extra or old fields (%#)', (input) => {
        expect(parseQuestionInput(input)).toBeNull();
    });
});

describe('AskQuestionCard selection and canonical whole-group output', () => {
    it('keeps single-select Other mutually exclusive and retains text when switching back', () => {
        const question = fixture().questions[0];
        let answer = { selectedOptionIndexes: [0], otherSelected: false, customText: '自定义' };
        answer = updateQuestionSelection(question, answer, 'other');
        expect(answer).toEqual({ selectedOptionIndexes: [], otherSelected: true, customText: '自定义' });
        answer = updateQuestionSelection(question, answer, 1);
        expect(answer).toEqual({ selectedOptionIndexes: [1], otherSelected: false, customText: '自定义' });
        const input = { questions: [question] };
        expect(buildQuestionOutput(input, { answers: [answer] })?.answers[0]).toEqual({
            questionIndex: 0,
            question: question.question,
            selectedOptions: ['其他']
        });
    });

    it('allows multi-select plus Other and emits preset labels in source order', () => {
        const input = fixture();
        const values = filledValues(input);
        values.answers[1] = updateQuestionSelection(input.questions[1], values.answers[1], 'other');
        values.answers[1].customText = '  第一行\n第二行  ';
        expect(buildQuestionOutput(input, values)).toEqual({
            answers: [
                { questionIndex: 0, question: input.questions[0].question, selectedOptions: [' 表格 '] },
                {
                    questionIndex: 1,
                    question: input.questions[1].question,
                    selectedOptions: ['整理,归档', '复盘'],
                    customText: '第一行\n第二行'
                }
            ]
        });
    });

    it('allows pure custom answers on both single and multi questions', () => {
        const input = fixture();
        const values = createEmptyValues(input);
        values.answers.forEach((answer) => {
            answer.otherSelected = true;
            answer.customText = '仅自定义';
        });
        expect(buildQuestionOutput(input, values)?.answers.map((answer) => answer.selectedOptions)).toEqual([[], []]);
    });

    it('blank Other blocks submission even when multi-select includes a preset', () => {
        const input = fixture();
        const values = filledValues(input);
        values.answers[1].otherSelected = true;
        values.answers[1].customText = ' \n\t ';
        expect(getAnswerError(input.questions[1], values.answers[1])).toContain('不能仅输入空白');
        expect(buildQuestionOutput(input, values)).toBeNull();
        values.answers[1].otherSelected = false;
        expect(buildQuestionOutput(input, values)?.answers[1]).not.toHaveProperty('customText');
    });

    it('requires every question and rejects duplicate, unknown, fractional and conflicting selections', () => {
        const input = fixture();
        expect(buildQuestionOutput(input, createEmptyValues(input))).toBeNull();
        expect(buildQuestionOutput(input, { answers: [filledValues(input).answers[0]] })).toBeNull();
        for (const indexes of [[0, 0], [-1], [2], [0.5], [0, 1]]) {
            const values = filledValues(input);
            values.answers[0].selectedOptionIndexes = indexes;
            expect(buildQuestionOutput(input, values)).toBeNull();
        }
        const values = filledValues(input);
        values.answers[0].otherSelected = true;
        values.answers[0].customText = '冲突';
        expect(buildQuestionOutput(input, values)).toBeNull();
    });

    it('supports checking and unchecking multi options without changing other answers', () => {
        const input = fixture();
        const values = filledValues(input);
        const first = structuredClone(values.answers[0]);
        values.answers[1] = updateQuestionSelection(input.questions[1], values.answers[1], 0, false);
        expect(values.answers[1].selectedOptionIndexes).toEqual([1]);
        values.answers[1] = updateQuestionSelection(input.questions[1], values.answers[1], 0, true);
        expect(values.answers[1].selectedOptionIndexes).toEqual([0, 1]);
        expect(values.answers[0]).toEqual(first);
        expect(updateQuestionSelection(input.questions[1], values.answers[1], 8)).toBe(values.answers[1]);
    });
});

describe('AskQuestionCard strict output parsing', () => {
    it('canonicalizes valid answer and selection order using question indexes even with identical text', () => {
        const input = fixture();
        input.questions[1].question = input.questions[0].question;
        const output = buildQuestionOutput(input, filledValues(input))!;
        const reversed = {
            answers: [...output.answers]
                .reverse()
                .map((answer) => ({ ...answer, selectedOptions: [...answer.selectedOptions].reverse() }))
        };
        expect(parseQuestionOutput(input, reversed)).toEqual(output);
    });

    it('rejects missing, duplicate, wrong-question, foreign-label and old answers', () => {
        const input = fixture();
        const output = buildQuestionOutput(input, filledValues(input))!;
        const badOutputs = [
            { selectedOption: ' 表格 ' },
            { answers: [output.answers[0]] },
            { answers: [output.answers[0], output.answers[0]] },
            { answers: [{ ...output.answers[0], question: '被修改' }, output.answers[1]] },
            { answers: [{ ...output.answers[0], selectedOptions: ['表格'] }, output.answers[1]] },
            { answers: [{ ...output.answers[0], selectedOptions: [' 表格 ', ' 表格 '] }, output.answers[1]] },
            { answers: [{ ...output.answers[0], customText: '冲突' }, output.answers[1]] },
            { answers: [output.answers[0], { ...output.answers[1], customText: ' \n ' }] },
            { answers: [output.answers[0], { ...output.answers[1], questionIndex: 1.5 }] },
            { answers: [output.answers[0], { ...output.answers[1], questionIndex: 2 }] },
            { answers: [{ ...output.answers[0], selectedOption: '旧字段' }, output.answers[1]] },
            { ...output, selectedOption: '旧字段' }
        ];
        badOutputs.forEach((value) => expect(parseQuestionOutput(input, value)).toBeNull());
    });
});

describe('AskQuestionCard draft restoration and fingerprint', () => {
    it('uses the exact shared deterministic serialization and treats absent multiSelect as false', () => {
        const input = fixture();
        expect(getInputFingerprint(input)).toBe(
            JSON.stringify(
                input.questions.map((q) => [
                    q.question,
                    q.header,
                    q.options.map((o) => [o.label, o.description, o.preview ?? null]),
                    q.multiSelect ?? false
                ])
            )
        );
        const explicit = structuredClone(input);
        explicit.questions[0].multiSelect = false;
        expect(getInputFingerprint(explicit)).toBe(getInputFingerprint(input));
        explicit.questions[0].options[0].description = '改变说明';
        expect(getInputFingerprint(explicit)).not.toBe(getInputFingerprint(input));
    });

    it('restores incomplete values and current question across unmount, without sharing mutable arrays', () => {
        const input = fixture();
        const values = createEmptyValues(input);
        values.answers[0].selectedOptionIndexes = [1];
        values.answers[1].otherSelected = true;
        values.answers[1].customText = '尚未填写完';
        const draft = { inputFingerprint: getInputFingerprint(input), currentQuestion: 1, values };
        const restored = restoreQuestionDraft(input, draft);
        expect(restored).toEqual(draft);
        restored.values.answers[0].selectedOptionIndexes.push(0);
        expect(draft.values.answers[0].selectedOptionIndexes).toEqual([1]);
    });

    it('discards changed-input or invalid-position/selection drafts', () => {
        const input = fixture();
        const draft = { inputFingerprint: getInputFingerprint(input), currentQuestion: 1, values: filledValues(input) };
        const expected = {
            inputFingerprint: getInputFingerprint(input),
            currentQuestion: 0,
            values: createEmptyValues(input)
        };
        expect(restoreQuestionDraft(input, { ...draft, inputFingerprint: 'old' })).toEqual(expected);
        expect(restoreQuestionDraft(input, { ...draft, currentQuestion: 2 })).toEqual(expected);
        draft.values.answers[0].selectedOptionIndexes = [8];
        expect(restoreQuestionDraft(input, draft)).toEqual(expected);
    });
});
