import { describe, expect, it } from 'vitest';

import {
    askUserQuestionInputSchema,
    askUserQuestionOutputSchema,
    validateQuestionMessages,
    validateQuestionAnswer
} from '@/agent/tools/question-validation';

import { pendingQuestionMessages, questionInput, questionOutput } from '../helpers/questions';

const question = questionInput.questions[0]!;

describe('strict question contracts', () => {
    it('accepts 1–4 questions with 2–4 structured options without mutating strings', () => {
        expect(askUserQuestionInputSchema.parse(questionInput)).toEqual(questionInput);
        expect(askUserQuestionInputSchema.safeParse({ questions: Array(4).fill(question) }).success).toBe(true);
        expect(
            askUserQuestionInputSchema.safeParse({
                questions: [
                    {
                        ...question,
                        options: Array.from({ length: 4 }, (_, i) => ({ label: ` ${i} `, description: ' x ' }))
                    }
                ]
            }).success
        ).toBe(true);
    });
    it.each([
        { questions: [] },
        { questions: Array(5).fill(question) },
        { questions: [{ ...question, options: [question.options[0]] }] },
        { questions: [{ ...question, options: Array(5).fill(question.options[0]) }] },
        { questions: [{ ...question, question: '  ' }] },
        { questions: [{ ...question, header: ' ' }] },
        { questions: [{ ...question, header: 'x'.repeat(13) }] },
        { questions: [{ ...question, multiSelect: 'true' }] },
        {
            questions: [
                {
                    ...question,
                    options: [
                        { label: 'A', description: ' ' },
                        { label: 'B', description: 'b' }
                    ]
                }
            ]
        },
        {
            questions: [
                {
                    ...question,
                    options: [
                        { label: 'A', description: 'a' },
                        { label: ' A ', description: 'b' }
                    ]
                }
            ]
        },
        {
            questions: [
                {
                    ...question,
                    options: [
                        { label: 'A', description: 'a', preview: 2 },
                        { label: 'B', description: 'b' }
                    ]
                }
            ]
        },
        { question: 'old', options: ['A', 'B'] },
        { ...questionInput, answers: {} }
    ])('rejects invalid input %#', (input) => {
        expect(askUserQuestionInputSchema.safeParse(input).success).toBe(false);
    });
    it('normalizes order and trims custom text, preserving commas/newlines and duplicate question text', () => {
        const output = structuredClone(questionOutput);
        output.answers.reverse();
        output.answers[1]!.selectedOptions.reverse();
        output.answers[1]!.customText = '  工作日\n集中提醒  ';
        expect(validateQuestionAnswer(questionInput, output)).toEqual(questionOutput);
    });
    it.each([
        { selectedOption: 'A' },
        { answers: [] },
        { answers: [questionOutput.answers[0], questionOutput.answers[0]] },
        { answers: [{ ...questionOutput.answers[0], question: 'edited' }, questionOutput.answers[1]] },
        { answers: [{ ...questionOutput.answers[0], selectedOptions: ['unknown'] }, questionOutput.answers[1]] },
        { answers: [{ ...questionOutput.answers[0], selectedOptions: ['其他', '其他'] }, questionOutput.answers[1]] },
        { answers: [{ ...questionOutput.answers[0], customText: '  ' }, questionOutput.answers[1]] },
        { answers: [questionOutput.answers[0], { ...questionOutput.answers[1], selectedOptions: ['A'] }] },
        {
            answers: [
                questionOutput.answers[0],
                { ...questionOutput.answers[1], selectedOptions: [], customText: undefined }
            ]
        },
        {
            answers: [
                { ...questionOutput.answers[0], selectedOptions: [], customText: undefined },
                questionOutput.answers[1]
            ]
        }
    ])('rejects invalid output %#', (output) => {
        expect(() => validateQuestionAnswer(questionInput, output)).toThrow();
    });
    it('rejects extra output fields', () => {
        expect(askUserQuestionOutputSchema.safeParse({ ...questionOutput, selectedOption: 'A' }).success).toBe(false);
    });
    it('preserves SDK partial input drafts but requires strict input once available', () => {
        const messages = structuredClone(pendingQuestionMessages);
        Object.assign(messages[1]!.parts![0]!, { state: 'input-streaming', input: { questions: [{}] } });
        expect(() => validateQuestionMessages(messages)).not.toThrow();
        Object.assign(messages[1]!.parts![0]!, { state: 'input-available' });
        expect(() => validateQuestionMessages(messages)).toThrow('完整新版格式');
        Object.assign(messages[1]!.parts![0]!, { state: 'input-streaming', output: questionOutput });
        expect(() => validateQuestionMessages(messages)).toThrow();
    });
    it('accepts new answered messages without a separate receipt and validates the input/output pair', () => {
        const messages = structuredClone(pendingQuestionMessages);
        Object.assign(messages[1]!.parts![0]!, { state: 'output-available', output: questionOutput });
        expect(() => validateQuestionMessages(messages)).not.toThrow();
        Object.assign(messages[1]!.parts![0]!, { output: { answers: [] } });
        expect(() => validateQuestionMessages(messages)).toThrow();
    });
});
