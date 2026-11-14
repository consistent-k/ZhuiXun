import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConversationStore, type IConversationService } from '@/modules/conversations';

import { pendingQuestionMessages, questionInput, questionOutput } from '../helpers/questions';
import { createTempData, type TempData } from '../helpers/temp-data';

let temp: TempData;
let store: IConversationService;
const answeredMessages = () => {
    const messages = structuredClone(pendingQuestionMessages);
    Object.assign(messages[1]!.parts![0]!, { state: 'output-available', output: questionOutput });
    return messages;
};

beforeEach(async () => {
    temp = await createTempData('question-result-');
    store = createConversationStore(temp.sessions);
    await store.appendMessages('s', structuredClone(pendingQuestionMessages));
});
afterEach(async () => {
    await temp.cleanup();
});

describe('question persistence through existing conversation writes', () => {
    it('accepts answered snapshots through append and upsert and preserves ordinary queue ordering', async () => {
        await Promise.all([
            store.appendMessages('s', answeredMessages()),
            store.appendMessages('s', [{ id: 'next', role: 'user', content: 'next' }])
        ]);
        const snapshot = (await createConversationStore(temp.sessions).get('s'))!;
        expect(snapshot.messages.map((m) => m.id)).toEqual(['user', 'assistant', 'next']);
        expect(snapshot.messages[1]?.parts?.[0]).toMatchObject({ state: 'output-available', output: questionOutput });
        await store.upsert('new', { title: '', createdAt: 1, messages: answeredMessages() });
        expect((await store.get('new'))?.messages[1]?.parts).toEqual(snapshot.messages[1]?.parts);
        // 整单保存保持覆盖语义，SDK regenerate 可直接移除旧 assistant，不需要专用删除接口。
        await store.upsert('s', { title: '', createdAt: 1, messages: pendingQuestionMessages.slice(0, 1) });
        expect((await store.get('s'))?.messages.map((m) => m.id)).toEqual(['user']);
    });

    it.each(['tool-askUserQuestion', 'dynamic-tool'])(
        'validates the %s input/output pair on both writes',
        async (type) => {
            const messages = answeredMessages();
            Object.assign(messages[1]!.parts![0]!, { type, toolName: 'askUserQuestion' });
            await store.appendMessages('s', messages);
            expect((await store.get('s'))?.messages[1]?.parts?.[0]).toMatchObject({ output: questionOutput });
            Object.assign(messages[1]!.parts![0]!, {
                output: {
                    answers: [{ ...questionOutput.answers[0]!, question: '不匹配的题干' }, questionOutput.answers[1]]
                }
            });
            await expect(store.appendMessages('s', messages)).rejects.toMatchObject({ status: 400 });
            await expect(store.upsert('bad', { title: '', createdAt: 1, messages })).rejects.toMatchObject({
                status: 400
            });
            expect(await store.get('bad')).toBeNull();
            expect((await store.get('s'))?.messages[1]?.parts?.[0]).toMatchObject({ output: questionOutput });
        }
    );

    it('roundtrips new answered/pending exports and preserves unused ids on a fresh import', async () => {
        await store.appendMessages('s', answeredMessages());
        await store.appendMessages('pending', structuredClone(pendingQuestionMessages));
        const exported = await store.exportAll();
        const imported = await store.importMany(exported.conversations);
        expect(imported.imported).toBe(2);
        const answeredId = imported.remapped.s!;
        const pendingId = imported.remapped.pending!;
        expect(answeredId).not.toBe('s');
        expect(pendingId).not.toBe('pending');
        const reload = createConversationStore(temp.sessions);
        const original = (await store.get('s'))!;
        const answerCopy = (await reload.get(answeredId))!;
        expect(answerCopy.messages).toEqual(original.messages);
        expect((await reload.get(pendingId))?.messages[1]?.parts?.[0]).toMatchObject({ state: 'input-available' });
        const fresh = createConversationStore(path.join(temp.root, 'fresh-import'));
        const freshResult = await fresh.importMany([answerCopy]);
        expect(freshResult.remapped).toEqual({});
        expect((await fresh.get(answerCopy.id))?.messages).toEqual(original.messages);
    });

    it.each(['tool-askUserQuestion', 'dynamic-tool'])(
        'rejects legacy and invalid %s imports before any row is written',
        async (type) => {
            const valid = (await store.exportOne('s'))!;
            const badPairs = [
                { state: 'input-available', input: { question: 'old', options: ['A', 'B'] } },
                { state: 'output-available', input: questionInput, output: { selectedOption: 'A' } },
                { state: 'output-available', input: questionInput, output: { answers: [] } }
            ];
            for (const pair of badPairs) {
                const invalid = {
                    ...valid,
                    id: 'invalid',
                    messages: [
                        {
                            ...pendingQuestionMessages[1],
                            parts: [{ type, toolName: 'askUserQuestion', toolCallId: 'old', ...pair }]
                        }
                    ]
                };
                await expect(
                    store.importMany([{ id: 'must-not-import', title: '', messages: [] }, invalid])
                ).rejects.toMatchObject({ status: 400 });
                expect(await store.get('must-not-import')).toBeNull();
            }
            expect(await store.list()).toHaveLength(1);
        }
    );
});
