import { randomUUID } from 'node:crypto';

import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ProviderModule from '@/agent/model/provider';
import { isQuestionPart } from '@/agent/tools/question-validation';
import { addProvider, deleteProvider, listProviders, setActiveModel, updateAppSettings } from '@/config/settings-store';
import { runChatTurn } from '@/modules/chat';
import { getConversationStore } from '@/modules/conversations';

import { questionInput, questionOutput } from '../helpers/questions';
import { fakeRegistry, runScenarioTurn, scriptedModel, userMessage } from '../helpers/scenario';

// 自动命名是独立后台任务，本场景只验证问答续跑，避免清理临时目录时仍有标题写入。
vi.mock('@/modules/conversations/title-generator', () => ({ generateConversationTitle: async () => undefined }));
const scenario = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock('@/agent/model/provider', async (original) => ({
    ...(await original<typeof ProviderModule>()),
    createModel: () => scenario.model
}));

beforeEach(() => {
    for (const provider of listProviders()) deleteProvider(provider.name);
    addProvider({
        name: 'questions',
        kind: 'openai-compatible',
        baseURL: 'https://model.invalid/v1',
        apiKey: 'fake',
        models: ['scripted']
    });
    setActiveModel('questions/scripted');
    updateAppSettings({ autoCompactEnabled: false });
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('scenario: client question tool results', () => {
    it.each(['routed', 'progressive'] as const)(
        '%s pauses for client input and resumes directly with structured answers',
        async (agentMode) => {
            const id = randomUUID();
            const model = scriptedModel([
                { toolCalls: [{ name: 'askUserQuestion', id: 'q', input: questionInput }] },
                { text: '收到完整答案' }
            ]);
            scenario.model = model;
            const first = await runScenarioTurn({ messages: [userMessage('请提问')], sessionId: id, agentMode });
            expect(first.chunks.some((c) => c.type === 'tool-approval-request')).toBe(false);
            expect(first.chunks.some((c) => c.type === 'tool-output-available')).toBe(false);
            expect(first.chunks.some((c) => c.type === 'error')).toBe(false);
            const store = getConversationStore();
            // 保存沿用既有后台队列；流完成与落盘之间允许短暂窗口。
            await vi.waitFor(async () => {
                expect(
                    (await store.get(id))?.messages.flatMap((m) => m.parts ?? []).find(isQuestionPart)
                ).toMatchObject({
                    state: 'input-available'
                });
            });
            const pending = (await store.get(id))!;
            const messages = pending.messages.map((m) => ({
                id: m.id,
                role: m.role,
                parts: m.parts ?? []
            })) as UIMessage[];
            // 模拟 addToolOutput 更新本地 part 后自动 stream，无额外结果提交。
            Object.assign(messages.flatMap((m) => m.parts).find(isQuestionPart)!, {
                state: 'output-available',
                output: questionOutput
            });
            const second = await runScenarioTurn({ messages, sessionId: id, agentMode });
            expect(second.chunks.some((c) => c.type === 'error')).toBe(false);
            const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
            expect(prompt).toContain('工作日\\n集中提醒');
            expect(prompt).toContain('通知,邮件');
            expect(prompt).toContain('questionIndex');
            await vi.waitFor(async () => {
                const saved = (await store.get(id))!;
                expect(saved.messages.flatMap((m) => m.parts ?? []).find(isQuestionPart)).toMatchObject({
                    state: 'output-available',
                    output: questionOutput
                });
                expect(saved.messages.some((m) => m.content.includes('收到完整答案'))).toBe(true);
            });
        }
    );

    it('rejects malformed client answers before model execution or persistence', async () => {
        const id = randomUUID();
        const model = scriptedModel([]);
        scenario.model = model;
        const messages: UIMessage[] = [
            userMessage('问我'),
            {
                id: 'assistant',
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-askUserQuestion',
                        toolCallId: 'q',
                        state: 'output-available',
                        input: questionInput,
                        output: { answers: [] }
                    }
                ]
            }
        ];
        await expect(runChatTurn({ messages, sessionId: id }, fakeRegistry())).rejects.toMatchObject({ status: 400 });
        expect(model.doStreamCalls).toHaveLength(0);
        expect(await getConversationStore().get(id)).toBeNull();
    });
});
