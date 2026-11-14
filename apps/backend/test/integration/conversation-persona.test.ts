import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConversationStore } from '@/modules/conversations';

import { createTempData, type TempData } from '../helpers/temp-data';

const message = { id: 'm1', role: 'user' as const, content: 'hello' };

let temp: TempData;

beforeEach(async () => {
    temp = await createTempData('zhuixun-persona-conversation-');
});

afterEach(async () => {
    await temp.cleanup();
});

describe('ConversationStore persona override', () => {
    it('persists, clears and preserves personaId across messages, index and export/import', async () => {
        const store = createConversationStore(temp.sessions);
        const meta = await store.upsert('conv', {
            title: '会话',
            createdAt: 1,
            personaId: 'teaching',
            messages: [message]
        });
        expect(meta.personaId).toBe('teaching');
        expect((await store.get('conv'))?.personaId).toBe('teaching');
        expect((await store.list())[0].personaId).toBe('teaching');

        await store.appendMessages('conv', [{ ...message, id: 'm2', content: 'next' }]);
        expect((await store.get('conv'))?.personaId).toBe('teaching');

        expect((await store.updatePersonaId('conv', 'concise'))?.personaId).toBe('concise');
        expect((await store.updatePersonaId('conv', null))?.personaId).toBeUndefined();
        expect((await store.get('conv'))?.personaId).toBeUndefined();

        await store.updatePersonaId('conv', 'teaching');
        const exported = await store.exportOne('conv');
        expect(exported?.personaId).toBe('teaching');

        const importedStore = createConversationStore(temp.sessions);
        const result = await importedStore.importMany([{ ...exported, id: 'imported' }]);
        expect(result.imported).toBe(1);
        const importedId = result.remapped.imported ?? 'imported';
        expect((await importedStore.get(importedId))?.personaId).toBe('teaching');
    });

    it('returns null for missing or invalid sessions', async () => {
        const store = createConversationStore(temp.sessions);
        await expect(store.updatePersonaId('missing', 'teaching')).resolves.toBeNull();
        await expect(store.updatePersonaId('../escape', 'teaching')).resolves.toBeNull();
    });
});
