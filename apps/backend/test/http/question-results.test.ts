import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createConversationsRouter } from '@/http/routes/conversations';
import { getConversationStore } from '@/modules/conversations';

import { pendingQuestionMessages, questionOutput } from '../helpers/questions';

const router = createConversationsRouter();
const put = (url: string, body: unknown) =>
    router.request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const answeredMessages = () => {
    const messages = structuredClone(pendingQuestionMessages);
    Object.assign(messages[1]!.parts![0]!, { state: 'output-available', output: questionOutput });
    return messages;
};

describe('question results in ordinary conversation requests', () => {
    it('saves new answers through full PUT and permits replacing the latest assistant for SDK regeneration', async () => {
        const id = randomUUID();
        await getConversationStore().appendMessages(id, structuredClone(pendingQuestionMessages));
        expect((await put(`/api/conversations/${id}`, { title: '', messages: answeredMessages() })).status).toBe(200);
        const loaded = await router.request(`/api/conversations/${id}`);
        expect(await loaded.json()).toMatchObject({
            data: { messages: [expect.anything(), { parts: [{ state: 'output-available', output: questionOutput }] }] }
        });
        expect(
            (await put(`/api/conversations/${id}`, { title: '', messages: pendingQuestionMessages.slice(0, 1) })).status
        ).toBe(200);
        expect((await getConversationStore().get(id))?.messages.map((m) => m.id)).toEqual(['user']);
    });

    it('roundtrips new answered exports via import and rejects old protocol at the HTTP boundary', async () => {
        const id = randomUUID();
        await getConversationStore().appendMessages(id, answeredMessages());
        const exported = await getConversationStore().exportOne(id);
        const importing = await router.request('/api/conversations/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ conversations: [exported] })
        });
        expect(importing.status).toBe(200);
        const result = (await importing.json()) as { data: { imported: number; remapped: Record<string, string> } };
        expect(result.data.imported).toBe(1);
        const importedId = result.data.remapped[id]!;
        expect(importedId).not.toBe(id);
        expect((await getConversationStore().get(importedId))?.messages).toEqual(exported?.messages);
        const legacy = structuredClone(exported)!;
        Object.assign(legacy.messages[1]!.parts![0]!, {
            input: { question: 'old', options: ['A', 'B'] },
            output: { selectedOption: 'A' }
        });
        const rejected = await router.request('/api/conversations/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ conversations: [legacy] })
        });
        expect(rejected.status).toBe(400);
    });

    it.each([{ selectedOption: 'A' }, { answers: [] }])(
        'rejects malformed or legacy output on full PUT %#',
        async (output) => {
            const messages = answeredMessages();
            Object.assign(messages[1]!.parts![0]!, { output });
            const id = randomUUID();
            expect((await put(`/api/conversations/${id}`, { title: '', messages })).status).toBe(400);
            expect(await getConversationStore().get(id)).toBeNull();
        }
    );
});
