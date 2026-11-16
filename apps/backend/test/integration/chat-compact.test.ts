import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Compaction from '@/agent/compaction';
import type * as ConfigModel from '@/config/model';
import { CompactError, compactConversation, getResumableStreamStore } from '@/modules/chat';
import { getConversationStore } from '@/modules/conversations';

const f = vi.hoisted(() => ({ force: vi.fn(), activeModel: vi.fn() }));
vi.mock('@/agent/compaction', async (original) => ({
    ...(await original<typeof Compaction>()),
    forceCompactContext: f.force
}));
vi.mock('@/config/model', async (original) => ({
    ...(await original<typeof ConfigModel>()),
    activeModel: f.activeModel
}));

const model = { kind: 'openai', baseURL: 'https://x.invalid', apiKey: 'test-only', modelName: 'm' };
const marker = { summarizedCount: 4, keptCount: 2, tokensBefore: 900, tokensAfter: 200 };

async function seed(id: string) {
    await getConversationStore().appendMessages(id, [
        { id: 'u1', role: 'user', content: '问' },
        { id: 'a1', role: 'assistant', content: '答', metadata: { usage: { totalTokens: 9 } } },
        { id: 'u2', role: 'user', content: '再问', parts: [{ type: 'text', text: '再问' }] },
        { id: 'a2', role: 'assistant', content: '再答', metadata: { compaction: marker } }
    ]);
}

beforeEach(() => {
    vi.clearAllMocks();
    f.activeModel.mockReturnValue(model);
});

describe('compactConversation (/compact)', () => {
    it('passes the exact history snapshot and manual instructions to compaction', async () => {
        await seed('compact-ok');
        f.force.mockResolvedValue({ changed: true, marker, modelInput: [] });
        await expect(compactConversation('compact-ok', '保留方案结论')).resolves.toEqual({
            changed: true,
            marker,
            messageId: 'a2'
        });
        const params = f.force.mock.calls[0][0];
        expect(params).toMatchObject({ sessionId: 'compact-ok', model, instructions: '保留方案结论' });
        expect(params.messages.map((m: { id: string }) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
        expect(params.messages[0].parts).toEqual([{ type: 'text', text: '问' }]);
        expect(params.messages[1].metadata).toEqual({ usage: { totalTokens: 9 } });
        const saved = await getConversationStore().get('compact-ok');
        expect(params.snapshot).toEqual(saved);
        expect(saved?.messages).toHaveLength(4);
    });

    it('returns unchanged without touching messages and tolerates conversations without assistant replies', async () => {
        await seed('compact-noop');
        f.force.mockResolvedValue({ changed: false, modelInput: [] });
        await expect(compactConversation('compact-noop')).resolves.toEqual({ changed: false });
        await getConversationStore().appendMessages('compact-user-only', [{ id: 'u', role: 'user', content: 'x' }]);
        f.force.mockResolvedValue({ changed: true, marker, modelInput: [] });
        await expect(compactConversation('compact-user-only')).resolves.toEqual({ changed: true, marker });
    });

    it('returns a conflict if the history changed while generating the summary', async () => {
        await seed('compact-conflict');
        f.force.mockResolvedValue({ changed: false, conflict: true, modelInput: [] });
        await expect(compactConversation('compact-conflict')).rejects.toMatchObject({ status: 409 });
    });

    it('rejects invalid ids, missing conversations, missing model and active streams', async () => {
        await expect(compactConversation('Bad Id')).rejects.toMatchObject({ status: 400 });
        await expect(compactConversation('compact-missing')).rejects.toMatchObject({ status: 404 });
        await seed('compact-no-model');
        f.activeModel.mockReturnValue(null);
        await expect(compactConversation('compact-no-model')).rejects.toBeInstanceOf(CompactError);
        const active = vi.spyOn(getResumableStreamStore(), 'getActiveIds').mockReturnValue(['compact-busy']);
        await expect(compactConversation('compact-busy')).rejects.toMatchObject({ status: 409 });
        active.mockRestore();
        expect(f.force).not.toHaveBeenCalled();
    });
});
