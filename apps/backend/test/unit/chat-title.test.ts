import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedModel } from '@/config/types';
import { generateConversationTitle } from '@/modules/conversations/title-generator';

const boundaries = vi.hoisted(() => ({
    generateText: vi.fn(),
    createModel: vi.fn(),
    warn: vi.fn()
}));
vi.mock('ai', () => ({ generateText: boundaries.generateText }));
vi.mock('@/agent/model/provider', () => ({ createModel: boundaries.createModel }));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => ({ warn: boundaries.warn }) }));

const model: ResolvedModel = {
    kind: 'openai-compatible',
    baseURL: 'https://model.invalid/v1',
    apiKey: 'test-only',
    modelName: 'fake-model'
};
const languageModel = { modelId: 'fake-model' };

beforeEach(() => {
    vi.resetAllMocks();
    boundaries.createModel.mockReturnValue(languageModel);
    boundaries.generateText.mockResolvedValue({ text: '检验结果解读' });
});

describe('generateConversationTitle', () => {
    it.each(['', ' \t\n '])('does not instantiate or call a model for empty input %j', async (input) => {
        await expect(generateConversationTitle(input, model)).resolves.toBeNull();
        expect(boundaries.createModel).not.toHaveBeenCalled();
        expect(boundaries.generateText).not.toHaveBeenCalled();
    });

    it('tolerates missing input at the runtime boundary', async () => {
        await expect(generateConversationTitle(undefined as unknown as string, model)).resolves.toBeNull();
        expect(boundaries.generateText).not.toHaveBeenCalled();
    });

    it('reuses the resolved provider and supplies title-only instructions with a bounded output budget', async () => {
        await expect(generateConversationTitle('  如何解读检验结果？ \n', model)).resolves.toBe('检验结果解读');
        expect(boundaries.createModel).toHaveBeenCalledExactlyOnceWith(model);
        expect(boundaries.generateText).toHaveBeenCalledExactlyOnceWith({
            model: languageModel,
            instructions: expect.stringContaining('你是什么模型 → 询问模型身份'),
            prompt: '用户提问：如何解读检验结果？',
            maxOutputTokens: 512,
            temperature: 0.3
        });
        expect(boundaries.warn).not.toHaveBeenCalled();
    });

    it('trims first and limits the prompt to the first 500 characters', async () => {
        await generateConversationTitle(`  ${'问'.repeat(501)}  `, model);
        expect(boundaries.generateText.mock.calls[0][0].prompt).toBe(`用户提问：${'问'.repeat(500)}`);
    });

    it.each([
        [' \n检验结果解读\n解释说明', '检验结果解读'],
        ['“检验结果解读”', '检验结果解读'],
        ["'检验结果解读'", '检验结果解读'],
        ['「『检验结果解读』」', '检验结果解读'],
        ['检验结果解读。.!！?？，,、；;：: ', '检验结果解读'],
        [' \t“检验结果解读” \t\n不要输出这一行', '检验结果解读'],
        ['安全帽佩戴规范', '安全帽佩戴规范'],
        ['风险评估方法', '风险评估方法'],
        ['检验'.repeat(10), '检验'.repeat(10)],
        ['检验'.repeat(11), '检验'.repeat(10)]
    ])('sanitizes %j into %j', async (raw, expected) => {
        boundaries.generateText.mockResolvedValue({ text: raw });
        await expect(generateConversationTitle('question', model)).resolves.toBe(expected);
    });

    it.each(['', ' \n ', '“”', '。！？', null, undefined])('returns null for unusable model text %j', async (text) => {
        boundaries.generateText.mockResolvedValue({ text });
        await expect(generateConversationTitle('question', model)).resolves.toBeNull();
        expect(boundaries.warn).toHaveBeenCalledWith('标题生成结果为空，降级为派生标题');
    });

    it.each([
        'User Safety: safe',
        'user safety',
        'Analysis: safe',
        'safety： unsafe',
        'Risk: none',
        'Moderation: harmless',
        'Content-Safety: safe',
        'safe',
        'UNSAFE',
        'none',
        'null',
        'n/a',
        'User input is safe',
        'Request is unsafe',
        'query is benign',
        'prompt is harmful',
        '安全',
        '不安全',
        '安全评估',
        '风险评估',
        '内容安全',
        '安全评估：安全',
        '风险评估: 无风险',
        '内容安全：unsafe',
        '不安全：',
        '安全：是'
    ])('rejects classifier verdict %j rather than presenting it as a title', async (text) => {
        boundaries.generateText.mockResolvedValue({ text });
        await expect(generateConversationTitle('question', model)).resolves.toBeNull();
        expect(boundaries.warn).toHaveBeenCalledWith('标题生成返回分类器式判定，降级为派生标题', {
            raw: text.replace(/[:：]$/, '')
        });
    });

    it('returns null when provider creation fails instead of rejecting the conversation', async () => {
        const failure = new Error('provider unavailable');
        boundaries.createModel.mockImplementation(() => {
            throw failure;
        });
        await expect(generateConversationTitle('question', model)).resolves.toBeNull();
        expect(boundaries.generateText).not.toHaveBeenCalled();
        expect(boundaries.warn).toHaveBeenCalledWith('标题生成失败，降级为派生标题', { err: failure });
    });

    it.each([new Error('model request failed'), 'transport rejected'])(
        'handles generation failure %j',
        async (failure) => {
            boundaries.generateText.mockRejectedValue(failure);
            await expect(generateConversationTitle('question', model)).resolves.toBeNull();
            expect(boundaries.warn).toHaveBeenCalledWith('标题生成失败，降级为派生标题', { err: failure });
        }
    );
});
