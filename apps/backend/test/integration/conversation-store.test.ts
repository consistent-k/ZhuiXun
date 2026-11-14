import fs from 'node:fs/promises';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompactionCheckpoint, IConversationService, StoredMessage } from '@/modules/conversations';
import { createConversationStore, deriveTitleFromMessages, isValidConversationId } from '@/modules/conversations';
import { createTaskStore } from '@/modules/tasks';

import { setEnv } from '../helpers/env';
import type { TempData } from '../helpers/temp-data';
import { createTempData } from '../helpers/temp-data';

const message = (id: string, content = id, timestamp?: number): StoredMessage => ({
    id,
    role: 'user',
    content,
    ...(timestamp === undefined ? {} : { timestamp })
});
const checkpoint: CompactionCheckpoint = {
    summary: 'earlier context',
    boundaryMessageId: 'm2',
    createdAt: 1_735_000_000_000,
    summarizedCount: 2,
    tokensBefore: 12_345
};

let temp: TempData;
let taskTemp: TempData;
let store: IConversationService;
let restoreEnv: () => void;

beforeAll(async () => {
    taskTemp = await createTempData('zhuixun-conversation-tasks-');
    restoreEnv = setEnv({ TASKS_USER_DIR: taskTemp.tasks });
});
beforeEach(async () => {
    temp = await createTempData('zhuixun-conversation-');
    store = createConversationStore(temp.sessions);
});
afterEach(async () => {
    vi.restoreAllMocks();
    await temp.cleanup();
});
afterAll(async () => {
    restoreEnv();
    await taskTemp.cleanup();
});

async function save(id = 'conversation-1', projectId?: string) {
    return store.upsert(id, { title: id, createdAt: 10, messages: [message('m1', 'hello', 11)], projectId });
}

describe('ConversationStore persistence', () => {
    it('starts empty, validates ids, and derives bounded titles from the first user message', async () => {
        await expect(store.list()).resolves.toEqual([]);
        await expect(store.readHistory()).resolves.toEqual([]);
        expect(isValidConversationId('session_1-good')).toBe(true);
        expect(isValidConversationId('../escape')).toBe(false);
        expect(deriveTitleFromMessages([])).toBe('新会话');
        expect(deriveTitleFromMessages([message('m', '   ')])).toBe('新会话');
        expect(deriveTitleFromMessages([message('m', '  abc  ')])).toBe('abc');
        expect(deriveTitleFromMessages([message('m', 'a'.repeat(21))])).toBe(`${'a'.repeat(20)}...`);
        await expect(store.get('../escape')).resolves.toBeNull();
        await expect(store.upsert('../escape', { title: '', createdAt: 0, messages: [] })).rejects.toThrow(
            '非法会话 id'
        );
        await expect(store.appendMessages('../escape', [])).rejects.toThrow('非法会话 id');
        await expect(store.updateTitle('../escape', 'title')).resolves.toBeNull();
        await expect(store.updateProjectId('../escape', null)).resolves.toBeNull();
        await expect(store.truncateFrom('../escape', 'm')).resolves.toBeNull();
        await expect(store.updateCompaction('../escape', checkpoint)).resolves.toBeUndefined();
        await expect(store.delete('../escape')).resolves.toBeUndefined();
        await expect(store.exportOne('missing')).resolves.toBeNull();
    });

    it('serializes concurrent writes and keeps original timestamps while merging message ids', async () => {
        await Promise.all([
            store.appendMessages('s', [message('m1', 'initial', 11)]),
            store.appendMessages('s', [message('m2', 'answer', 22)]),
            store.appendMessages('s', [message('m1', 'revised', 99), message('m3')])
        ]);
        const saved = await store.get('s');
        expect(saved?.title).toBe('initial');
        expect(saved?.messages).toEqual([
            message('m1', 'revised', 11),
            message('m2', 'answer', 22),
            expect.objectContaining({ id: 'm3', timestamp: expect.any(Number) })
        ]);
        expect((await createConversationStore(temp.sessions).list()).map((m) => m.id)).toEqual(['s']);
        expect((await store.readHistory()).map((e) => e.messageCount)).toEqual([1, 2, 3]);
    });

    it('preserves timestamps, origin, compaction, frozen roots and AI title across upserts', async () => {
        const roots = [{ path: temp.root, primary: true }];
        const origin = { kind: 'channel' as const, channelId: 'telegram', imUserId: 'test-user' };
        await store.upsert('s', { title: 'first', createdAt: 10, messages: [message('m1', 'old', 11)], roots, origin });
        await store.updateTitle('s', ' AI title ', { auto: true });
        await store.updateCompaction('s', checkpoint);
        await store.upsert('s', {
            title: 'stale UI title',
            createdAt: 0,
            messages: [message('m1', 'new', 99), message('m2', 'new', 22)],
            roots: [{ path: '/not-the-original', primary: true }]
        });
        await store.appendMessages('s', [message('m2', 'latest', 33)], {
            title: 'also stale',
            roots: [{ path: '/other' }],
            projectId: 'p'
        });
        await expect(store.get('s')).resolves.toMatchObject({
            title: 'AI title',
            titleAuto: true,
            createdAt: 10,
            projectId: 'p',
            origin,
            roots,
            compaction: checkpoint,
            messages: [message('m1', 'new', 11), message('m2', 'latest', 22)]
        });
        await expect(createConversationStore(temp.sessions).list()).resolves.toMatchObject([
            { title: 'AI title', titleAuto: true, origin }
        ]);
    });

    it('fills new timestamps and appends legacy messages without timestamps', async () => {
        await fs.mkdir(temp.sessions, { recursive: true });
        await fs.writeFile(
            path.join(temp.sessions, 'legacy.json'),
            JSON.stringify({
                version: 1,
                id: 'legacy',
                title: 'legacy',
                createdAt: 1,
                updatedAt: 1,
                messages: [message('m1')]
            })
        );
        await store.appendMessages('legacy', [message('m1', 'filled', 7), message('m2')], {
            title: 'renamed',
            roots: [{ path: temp.root }]
        });
        await expect(store.get('legacy')).resolves.toMatchObject({
            title: 'renamed',
            roots: [{ path: temp.root }],
            messages: [message('m1', 'filled', 7), expect.objectContaining({ id: 'm2', timestamp: expect.any(Number) })]
        });
        await store.upsert('new', { title: 'new', createdAt: 0, messages: [message('m')] });
        await expect(store.get('new')).resolves.toMatchObject({
            createdAt: expect.any(Number),
            messages: [expect.objectContaining({ timestamp: expect.any(Number) })]
        });
    });

    it('filters project buckets, moves conversations and updates explicit titles', async () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
        await save('a', 'p');
        await save('b');
        expect((await store.list()).map((m) => m.id)).toEqual(['b', 'a']);
        expect((await store.list('p')).map((m) => m.id)).toEqual(['a']);
        expect((await store.list(null)).map((m) => m.id)).toEqual(['b']);
        await expect(store.updateProjectId('a', null)).resolves.toMatchObject({ id: 'a', projectId: undefined });
        await expect(store.list('')).resolves.toHaveLength(2);
        await expect(store.updateTitle('a', ' manual ')).resolves.toMatchObject({ title: 'manual' });
        await expect(store.updateTitle('a', ' ')).resolves.toBeNull();
        await expect(store.updateTitle('missing', 'ok')).resolves.toBeNull();
        await expect(store.updateProjectId('missing', 'p')).resolves.toBeNull();
    });

    it('updates compaction without changing ordering or timestamps, then truncates messages', async () => {
        await save('s');
        await store.appendMessages('s', [message('m2'), message('m3')]);
        const before = await store.get('s');
        const indexBefore = await fs.readFile(path.join(temp.sessions, 'index.json'), 'utf8');
        await store.updateCompaction('s', checkpoint);
        await expect(store.get('s')).resolves.toMatchObject({ updatedAt: before!.updatedAt, compaction: checkpoint });
        expect(await fs.readFile(path.join(temp.sessions, 'index.json'), 'utf8')).toBe(indexBefore);
        await expect(store.updateCompaction('missing', checkpoint)).resolves.toBeUndefined();
        await expect(store.truncateFrom('missing', 'm1')).resolves.toBeNull();
        await expect(store.truncateFrom('s', 'missing')).resolves.toBeNull();
        await expect(store.truncateFrom('s', 'm2')).resolves.toMatchObject({ id: 's' });
        expect((await store.get('s'))?.messages.map((m) => m.id)).toEqual(['m1']);
        expect((await store.readHistory()).at(-1)).toMatchObject({ event: 'save', messageCount: 1 });
    });

    it('rebuilds a missing or syntactically corrupt index and isolates corrupt files', async () => {
        await save('good');
        await fs.writeFile(path.join(temp.sessions, 'bad.json'), '{');
        await fs.writeFile(path.join(temp.sessions, 'notes.txt'), 'ignore');
        for (const index of [undefined, '{']) {
            if (index === undefined) await fs.rm(path.join(temp.sessions, 'index.json'));
            else await fs.writeFile(path.join(temp.sessions, 'index.json'), index);
            await expect(createConversationStore(temp.sessions).list()).resolves.toMatchObject([{ id: 'good' }]);
        }
        await expect(store.get('bad')).rejects.toThrow();
    });

    it.each(['{}', 'null', '[null]', '[{"id":"../escape"}]'])(
        'rebuilds structurally invalid index %s without publishing corrupt metadata',
        async (index) => {
            await save('good');
            await fs.writeFile(path.join(temp.sessions, 'index.json'), index);
            await fs.writeFile(path.join(temp.sessions, 'invalid.json'), '{}');
            await fs.writeFile(path.join(temp.sessions, 'null.json'), 'null');
            await expect(createConversationStore(temp.sessions).list()).resolves.toMatchObject([{ id: 'good' }]);
            await expect(createConversationStore(temp.sessions).list()).resolves.toHaveLength(1);
        }
    );

    it('skips corrupt and structurally invalid history records without losing valid events', async () => {
        await save('s');
        const [event] = await store.readHistory();
        await fs.appendFile(path.join(temp.sessions, 'history.jsonl'), '\n{bad\nnull\n123\n{}\n{"event":"other"}\n');
        await expect(store.readHistory()).resolves.toEqual([event]);
        await fs.rm(path.join(temp.sessions, 'history.jsonl'));
        await fs.mkdir(path.join(temp.sessions, 'history.jsonl'));
        await expect(store.readHistory()).rejects.toThrow();
        await expect(save('later')).resolves.toMatchObject({ id: 'later' });
    });

    it('does not publish an index cache on failed persistence and recovers its write queue', async () => {
        await save('first');
        const indexFile = path.join(temp.sessions, 'index.json');
        await fs.rm(indexFile);
        await fs.mkdir(indexFile);
        await expect(save('second')).rejects.toThrow();
        expect((await store.list()).map((m) => m.id)).toEqual(['first']);
        await fs.rm(indexFile, { recursive: true });
        await save('third');
        expect((await store.list()).map((m) => m.id).sort()).toEqual(['first', 'third']);
        await expect(createConversationStore(temp.sessions).list()).resolves.toHaveLength(2);
    });

    it('propagates unreadable root failures and leaves the queue usable', async () => {
        await fs.writeFile(temp.sessions, 'not a directory');
        await expect(store.list()).rejects.toThrow();
        await expect(save()).rejects.toThrow();
        await fs.rm(temp.sessions);
        await expect(save()).resolves.toMatchObject({ id: 'conversation-1' });
    });
});

describe('ConversationStore import, export and removal', () => {
    it('preserves compaction checkpoints across export and import', async () => {
        const target = createConversationStore(path.join(temp.root, 'target'));
        await store.upsert('s', {
            title: 'Imported',
            createdAt: checkpoint.createdAt,
            messages: [message('m1'), message('m2')],
            compaction: checkpoint
        });
        const exported = await store.exportAll();
        expect(exported).toMatchObject({ version: 1, exportedAt: expect.any(Number) });
        await expect(target.importMany(exported.conversations)).resolves.toEqual({ imported: 1, remapped: {} });
        await expect(target.get('s')).resolves.toMatchObject({ compaction: checkpoint });
        await expect(store.exportOne('s')).resolves.toEqual(exported.conversations[0]);
    });

    it('remaps conflicting and unsafe ids, ignores invalid rows and normalizes optional metadata', async () => {
        await save('s');
        const raw = {
            id: 's',
            title: 'import',
            messages: [],
            titleAuto: true,
            projectId: 'p',
            roots: [{ path: temp.root }],
            compaction: checkpoint
        };
        const result = await store.importMany([
            null,
            1,
            {},
            { id: 1, title: 'bad', messages: [] },
            { id: 'bad', title: 'bad' },
            raw,
            { ...raw, id: '../unsafe', createdAt: 123 },
            {
                id: 'new',
                title: 'new',
                messages: [],
                titleAuto: 'bad',
                projectId: 2,
                roots: {},
                compaction: { ...checkpoint, createdAt: 'bad' }
            }
        ]);
        expect(result.imported).toBe(3);
        expect(Object.keys(result.remapped).sort()).toEqual(['../unsafe', 's']);
        for (const id of Object.values(result.remapped)) expect(isValidConversationId(id)).toBe(true);
        await expect(store.get(result.remapped.s)).resolves.toMatchObject({
            title: 'import',
            titleAuto: true,
            projectId: 'p',
            roots: raw.roots,
            compaction: checkpoint
        });
        await expect(store.get(result.remapped['../unsafe'])).resolves.toMatchObject({ createdAt: 123 });
        const normalized = await store.get('new');
        expect(normalized?.titleAuto).toBeUndefined();
        expect(normalized?.projectId).toBeUndefined();
        expect(normalized?.roots).toBeUndefined();
        expect(normalized?.compaction).toBeUndefined();
        await expect(store.importMany({})).resolves.toEqual({ imported: 0, remapped: {} });
    });

    it.each([null, {}, { ...checkpoint, summarizedCount: 'bad' }, { ...checkpoint, boundaryMessageId: 1 }])(
        'drops malformed imported compaction %j',
        async (compaction) => {
            await store.importMany([{ id: 's', title: 't', messages: [], compaction }]);
            expect((await store.get('s'))?.compaction).toBeUndefined();
        }
    );

    it('accepts checkpoints without optional token counts and skips missing export files', async () => {
        await store.importMany([
            { id: 's', title: 't', messages: [], updatedAt: 12, compaction: { ...checkpoint, tokensBefore: 'bad' } }
        ]);
        expect((await store.get('s'))?.compaction).toEqual({ ...checkpoint, tokensBefore: undefined });
        await fs.rm(path.join(temp.sessions, 's.json'));
        await expect(store.exportAll()).resolves.toMatchObject({ conversations: [] });
    });

    it('ungroups project conversations, preserving messages, then cascades attachments and tasks', async () => {
        await save('a', 'p');
        await save('b', 'p');
        await save('other', 'q');
        await expect(store.handleProjectRemoval('', true)).resolves.toEqual([]);
        await expect(store.handleProjectRemoval('missing', false)).resolves.toEqual([]);
        await fs.rm(path.join(temp.sessions, 'b.json'));
        expect((await store.handleProjectRemoval('p', false)).sort()).toEqual(['a', 'b']);
        await expect(store.get('a')).resolves.toMatchObject({ messages: [message('m1', 'hello', 11)] });
        expect((await store.list(null)).map((m) => m.id).sort()).toEqual(['a', 'b']);
        await store.updateProjectId('a', 'p');
        await fs.mkdir(path.join(temp.sessions, 'a', 'uploads'), { recursive: true });
        await fs.writeFile(path.join(temp.sessions, 'a', 'uploads', 'asset'), 'attachment');
        await createTaskStore(taskTemp.tasks).create('a', [{ subject: 'linked task' }]);
        await expect(store.handleProjectRemoval('p', true)).resolves.toEqual(['a']);
        await expect(fs.stat(path.join(temp.sessions, 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.stat(path.join(taskTemp.tasks, 'a.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await store.list()).map((m) => m.id).sort()).toEqual(['b', 'other']);
    });

    it('deletes idempotently and clears only indexed conversations with their owned directories', async () => {
        await save('a');
        await save('b');
        await fs.mkdir(path.join(temp.sessions, 'a', 'uploads'), { recursive: true });
        await fs.mkdir(path.join(temp.sessions, 'b', 'checkpoints'), { recursive: true });
        await createTaskStore(taskTemp.tasks).create('b', [{ subject: 'linked' }]);
        await store.delete('a');
        await store.delete('a');
        await expect(fs.stat(path.join(temp.sessions, 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(store.clear()).resolves.toBe(1);
        await expect(store.clear()).resolves.toBe(0);
        await expect(store.list()).resolves.toEqual([]);
        await expect(fs.stat(path.join(temp.sessions, 'b'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.stat(path.join(taskTemp.tasks, 'b.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await store.readHistory()).slice(-4).map((e) => e.event)).toEqual([
            'delete',
            'delete',
            'clear',
            'clear'
        ]);
    });
});
