import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCheckpointStore, getCheckpointStore } from '@/modules/conversations';

import type { TempData } from '../helpers/temp-data';
import { createTempData } from '../helpers/temp-data';

let temp: TempData;
let store: ReturnType<typeof createCheckpointStore>;
const empty = { restored: [], deleted: [], skipped: [] };
const sid = 'session-1';
const turnRoot = (turn: string) => path.join(temp.sessions, sid, 'checkpoints', turn);
const hash = (file: string) => createHash('sha1').update(path.resolve(file)).digest('hex');
const orderFile = () => path.join(temp.sessions, sid, 'checkpoints', 'order.json');
beforeEach(async () => {
    temp = await createTempData('zhuixun-checkpoint-');
    store = createCheckpointStore(temp.sessions);
});
afterEach(async () => {
    await temp.cleanup();
});

async function file(name: string, content: string | Buffer = 'before') {
    const target = path.join(temp.root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return target;
}

describe('conversation file checkpoints', () => {
    it('first touch wins within a turn even for concurrent recorders and normalized path aliases', async () => {
        const target = await file('note.md');
        const a = store.recorder(sid, 'turn-1');
        const b = store.recorder(sid, 'turn-1');
        await Promise.all([a.record(target), b.record(path.join(temp.root, 'sub', '..', 'note.md'))]);
        await fs.writeFile(target, 'middle');
        await a.record(target);
        await fs.writeFile(target, 'after');
        expect(JSON.parse(await fs.readFile(orderFile(), 'utf8'))).toEqual(['turn-1']);
        expect(
            Object.keys(JSON.parse(await fs.readFile(path.join(turnRoot('turn-1'), 'manifest.json'), 'utf8')))
        ).toHaveLength(1);
        const reloaded = createCheckpointStore(temp.sessions);
        await expect(reloaded.rewind(sid, 'turn-1')).resolves.toEqual({ restored: [target], deleted: [], skipped: [] });
        expect(await fs.readFile(target, 'utf8')).toBe('before');
        await expect(reloaded.rewind(sid, 'turn-1')).resolves.toEqual(empty);
    });

    it('rewinds multiple turns from each file earliest pre-state, deleting newly created files', async () => {
        const shared = await file('shared.txt', Buffer.from([0, 1, 255]));
        const later = await file('later.txt', 'original later');
        const created = path.join(temp.root, 'new.txt');
        await store.recorder(sid, 't0').record(shared);
        await fs.writeFile(shared, 't0 content');
        await store.recorder(sid, 't1').record(shared);
        await store.recorder(sid, 't1').record(created);
        await fs.writeFile(shared, 't1 content');
        await fs.writeFile(created, 'created in t1');
        await store.recorder(sid, 't2').record(shared);
        await store.recorder(sid, 't2').record(later);
        await store.recorder(sid, 't2').record(created);
        await fs.writeFile(shared, 't2 content');
        await fs.writeFile(later, 't2 later');
        const result = await store.rewind(sid, 't1');
        expect(result.restored.sort()).toEqual([shared, later].sort());
        expect(result.deleted).toEqual([created]);
        expect(result.skipped).toEqual([]);
        expect(await fs.readFile(shared, 'utf8')).toBe('t0 content');
        expect(await fs.readFile(later, 'utf8')).toBe('original later');
        await expect(fs.stat(created)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(JSON.parse(await fs.readFile(orderFile(), 'utf8'))).toEqual(['t0']);
        await expect(fs.stat(turnRoot('t1'))).rejects.toMatchObject({ code: 'ENOENT' });
        await store.rewind(sid, 't0');
        expect(await fs.readFile(shared)).toEqual(Buffer.from([0, 1, 255]));
    });

    it('recreates deleted parent directories while restoring original files', async () => {
        const target = await file('nested/dir/note.md');
        await store.recorder(sid, 't').record(target);
        await fs.rm(path.join(temp.root, 'nested'), { recursive: true });
        await expect(store.rewind(sid, 't')).resolves.toEqual({ restored: [target], deleted: [], skipped: [] });
        expect(await fs.readFile(target, 'utf8')).toBe('before');
    });

    it('skips oversized files and missing snapshots without preventing unrelated restores', async () => {
        const big = await file('big.bin', Buffer.alloc(5 * 1024 * 1024 + 1, 1));
        const missing = await file('missing.txt');
        const good = await file('good.txt');
        const recorder = store.recorder(sid, 't');
        await recorder.record(big);
        await recorder.record(missing);
        await recorder.record(good);
        await fs.rm(path.join(turnRoot('t'), hash(missing)));
        await fs.writeFile(big, 'new big');
        await fs.writeFile(good, 'new good');
        const result = await store.rewind(sid, 't');
        expect(result.skipped.sort()).toEqual([big, missing].sort());
        expect(result.restored).toEqual([good]);
        expect(await fs.readFile(big, 'utf8')).toBe('new big');
        expect(await fs.readFile(good, 'utf8')).toBe('before');
    });

    it('bounds snapshot size inclusively and reports deletion failure as skipped', async () => {
        const edge = await file('edge.bin', Buffer.alloc(5 * 1024 * 1024, 2));
        const created = path.join(temp.root, 'becomes-directory');
        await store.recorder(sid, 't').record(edge);
        await store.recorder(sid, 't').record(created);
        await fs.writeFile(edge, 'changed');
        await fs.mkdir(created);
        await file('becomes-directory/child');
        const result = await store.rewind(sid, 't');
        expect(result.restored).toEqual([edge]);
        expect(result.skipped).toEqual([created]);
        expect((await fs.stat(edge)).size).toBe(5 * 1024 * 1024);
    });

    it('no-ops for invalid session bindings, empty turns and unknown rewind turns', async () => {
        const target = await file('file');
        for (const [session, turn] of [
            [undefined, 't'],
            ['../escape', 't'],
            [sid, undefined],
            [sid, '']
        ]) {
            await store.recorder(session, turn).record(target);
        }
        await expect(fs.stat(temp.sessions)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(store.rewind('../escape', 't')).resolves.toEqual(empty);
        await expect(store.rewind(sid, 'missing')).resolves.toEqual(empty);
        expect(getCheckpointStore()).toBe(getCheckpointStore());
    });

    it('record is best effort and recovers after filesystem failures and directory inputs', async () => {
        const target = await file('note');
        await fs.writeFile(temp.sessions, 'blocked');
        await expect(store.recorder(sid, 't').record(target)).resolves.toBeUndefined();
        await fs.rm(temp.sessions);
        await expect(store.recorder(sid, 't').record(temp.root)).resolves.toBeUndefined();
        await store.recorder(sid, 't').record(target);
        await fs.writeFile(target, 'after');
        await expect(store.rewind(sid, 't')).resolves.toEqual({ restored: [target], deleted: [], skipped: [] });
    });

    it.each(['.', '..', '***', 'turn/with:punctuation'])(
        'keeps turn id %s strictly inside checkpoints',
        async (turn) => {
            const target = await file('note');
            await store.recorder(sid, turn).record(target);
            await expect(fs.stat(path.join(temp.sessions, sid, 'manifest.json'))).rejects.toMatchObject({
                code: 'ENOENT'
            });
            await expect(fs.stat(path.join(temp.sessions, sid, 'checkpoints', 'manifest.json'))).rejects.toMatchObject({
                code: 'ENOENT'
            });
            await fs.writeFile(target, 'changed');
            await expect(store.rewind(sid, turn)).resolves.toEqual({ restored: [target], deleted: [], skipped: [] });
        }
    );

    it.each(['{broken', 'null', '{}', '[null]'])(
        'ignores corrupt order %s and keeps later writes usable',
        async (raw) => {
            await fs.mkdir(path.dirname(orderFile()), { recursive: true });
            await fs.writeFile(orderFile(), raw);
            await expect(store.rewind(sid, 'unknown')).resolves.toEqual(empty);
            const target = await file('note');
            await store.recorder(sid, 't').record(target);
            await fs.writeFile(target, 'changed');
            await expect(store.rewind(sid, 't')).resolves.toEqual({ restored: [target], deleted: [], skipped: [] });
        }
    );

    it.each(['{broken', 'null', '[]', '{"bad":null}', '{"bad":{"absPath":"relative","existedBefore":true}}'])(
        'ignores malformed manifest %s without failing the whole rewind',
        async (raw) => {
            const target = await file('note');
            await store.recorder(sid, 't0').record(target);
            await store.recorder(sid, 't1').record(target);
            await fs.writeFile(path.join(turnRoot('t0'), 'manifest.json'), raw);
            await fs.writeFile(target, 'changed');
            await expect(store.rewind(sid, 't0')).resolves.toEqual({ restored: [target], deleted: [], skipped: [] });
        }
    );
});
