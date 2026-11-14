import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTaskStore } from '@/modules/tasks';

import type { TempData } from '../helpers/temp-data';
import { createTempData } from '../helpers/temp-data';

describe('TaskStore', () => {
    it('rejects an invalid or missing session id instead of using a default file', async () => {
        const temp = await createTempData();
        try {
            const store = createTaskStore(temp.tasks);
            await expect(store.list()).rejects.toThrow('缺少或非法会话 id');
            await expect(store.list('../escape')).rejects.toThrow('缺少或非法会话 id');
            await expect(store.delete('../escape')).rejects.toThrow('缺少或非法会话 id');
        } finally {
            await temp.cleanup();
        }
    });

    it('enforces one in-progress task and preserves failed patch changes', async () => {
        const temp = await createTempData();
        try {
            const store = createTaskStore(temp.tasks);
            const created = await store.create('session-1', [{ subject: 'first' }, { subject: 'second' }]);
            await expect(
                store.updateMany('session-1', [{ taskId: created[0].id, status: 'in_progress' }])
            ).resolves.toMatchObject({
                ok: true
            });

            const conflict = await store.updateMany('session-1', [{ taskId: created[1].id, status: 'in_progress' }]);
            expect(conflict).toMatchObject({ ok: false });

            const blocked = await store.updateMany('session-1', [
                {
                    taskId: created[1].id,
                    subject: 'should not persist',
                    addBlockedBy: [created[0].id],
                    status: 'in_progress'
                }
            ]);
            expect(blocked).toMatchObject({ ok: false });
            await expect(store.list('session-1')).resolves.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: created[0].id, status: 'in_progress' }),
                    expect.objectContaining({ id: created[1].id, status: 'pending', subject: 'second', blockedBy: [] })
                ])
            );
        } finally {
            await temp.cleanup();
        }
    });
});

describe('TaskStore persistence and dependency batches', () => {
    let temp: TempData;
    beforeEach(async () => {
        temp = await createTempData();
    });
    afterEach(async () => {
        await temp.cleanup();
    });

    it('normalizes whitespace around session ids and rejects invalid ids for every mutation', async () => {
        const store = createTaskStore(temp.tasks);
        for (const id of [undefined, '', '   ', '../escape', 'a/b', 'a'.repeat(129)]) {
            await expect(store.list(id)).rejects.toThrow('缺少或非法会话 id');
            await expect(store.create(id, [{ subject: 'bad' }])).rejects.toThrow('缺少或非法会话 id');
            await expect(store.updateMany(id, [])).rejects.toThrow('缺少或非法会话 id');
        }
        await expect(store.list('empty')).resolves.toEqual([]);
        await expect(fs.stat(temp.tasks)).rejects.toMatchObject({ code: 'ENOENT' });
        await store.create(' session-1 ', [{ subject: 'trimmed' }]);
        await expect(store.list('session-1')).resolves.toEqual([
            expect.objectContaining({ id: '1', subject: 'trimmed' })
        ]);
        expect(await fs.readdir(temp.tasks)).toEqual(['session-1.json']);
    });

    it.each(['{broken', 'null', '{}'])('recovers from invalid or missing task data %s in a real file', async (raw) => {
        await fs.mkdir(temp.tasks);
        await fs.writeFile(path.join(temp.tasks, 'session.json'), raw);
        const store = createTaskStore(temp.tasks);
        await expect(store.list('session')).resolves.toEqual([]);
        const tasks = await store.create('session', [{ subject: 'Recovered' }]);
        expect(tasks).toEqual([
            expect.objectContaining({ id: '1', subject: 'Recovered', status: 'pending', blocks: [], blockedBy: [] })
        ]);
        await expect(createTaskStore(temp.tasks).list('session')).resolves.toEqual(tasks);
    });

    it('persists fields, isolates sessions and resumes each session sequence after reopening', async () => {
        const store = createTaskStore(temp.tasks);
        const first = await store.create('first', [
            { subject: 'Research', description: 'Use evidence', activeForm: 'Researching' }
        ]);
        expect(first[0]).toMatchObject({
            id: '1',
            subject: 'Research',
            description: 'Use evidence',
            activeForm: 'Researching',
            status: 'pending'
        });
        await store.create('second', [{ subject: 'Independent' }]);
        const fresh = createTaskStore(temp.tasks);
        const tasks = await fresh.create('first', [{ subject: 'Next' }]);
        expect(tasks.map((t) => t.id)).toEqual(['1', '2']);
        await expect(fresh.list('second')).resolves.toEqual([
            expect.objectContaining({ id: '1', subject: 'Independent' })
        ]);
        const disk = JSON.parse(await fs.readFile(path.join(temp.tasks, 'first.json'), 'utf8'));
        expect(disk).toEqual({ version: 1, seq: 2, tasks: JSON.parse(JSON.stringify(tasks)) });
    });

    it('serializes concurrent creates and updates without dropping tasks or fields', async () => {
        const store = createTaskStore(temp.tasks);
        await Promise.all(Array.from({ length: 12 }, (_, i) => store.create('session', [{ subject: `Task ${i}` }])));
        await Promise.all([
            store.updateMany('session', [{ taskId: '1', description: 'description' }]),
            store.updateMany('session', [{ taskId: '1', activeForm: 'Working', subject: 'Updated' }])
        ]);
        const tasks = await store.list('session');
        expect(tasks.map((t) => t.id)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
        expect(tasks[0]).toMatchObject({ description: 'description', activeForm: 'Working', subject: 'Updated' });
        await expect(createTaskStore(temp.tasks).list('session')).resolves.toEqual(tasks);
    });

    it('builds deduplicated reverse edges in both directions and ignores self-dependencies', async () => {
        const store = createTaskStore(temp.tasks);
        await store.create('session', [{ subject: 'One' }, { subject: 'Two' }, { subject: 'Three' }]);
        const result = await store.updateMany('session', [
            { taskId: '1', addBlocks: ['1', '2', '2'] },
            { taskId: '3', addBlockedBy: ['2', '2', '3'] },
            { taskId: '2', addBlockedBy: ['1'], addBlocks: ['3'] }
        ]);
        expect(result).toMatchObject({ ok: true, failed: [] });
        const tasks = await store.list('session');
        expect(tasks.map(({ id, blocks, blockedBy }) => ({ id, blocks, blockedBy }))).toEqual([
            { id: '1', blocks: ['2'], blockedBy: [] },
            { id: '2', blocks: ['3'], blockedBy: ['1'] },
            { id: '3', blocks: [], blockedBy: ['2'] }
        ]);
        await expect(createTaskStore(temp.tasks).list('session')).resolves.toEqual(tasks);
    });

    it('rejects a multi-hop cycle without leaking either reverse edges or fields from the failed patch', async () => {
        const store = createTaskStore(temp.tasks);
        await store.create('session', [{ subject: 'One' }, { subject: 'Two' }, { subject: 'Three' }]);
        await store.updateMany('session', [
            { taskId: '1', addBlocks: ['2', '3'] },
            { taskId: '2', addBlocks: ['3'] }
        ]);
        const before = await store.list('session');
        await expect(
            store.updateMany('session', [{ taskId: '1', addBlockedBy: ['3'], subject: 'must not leak' }])
        ).resolves.toEqual({ ok: false, message: '#1: 建立该依赖会形成环，已拒绝' });
        await expect(store.list('session')).resolves.toEqual(before);
        await expect(createTaskStore(temp.tasks).list('session')).resolves.toEqual(before);
    });

    it('aggregates all-failed patches in order and keeps unknown dependency failures atomic', async () => {
        const store = createTaskStore(temp.tasks);
        const before = await store.create('session', [{ subject: 'One' }, { subject: 'Two' }]);
        await expect(
            store.updateMany('session', [
                { taskId: 'missing', subject: 'Bad' },
                { taskId: '1', addBlocks: ['2', 'unknown'], description: 'must not leak' }
            ])
        ).resolves.toEqual({
            ok: false,
            message: '#missing: 任务 missing 不存在，请先 TaskList 确认 id；#1: 依赖引用的任务 unknown 不存在'
        });
        await expect(store.list('session')).resolves.toEqual(before);
        await expect(createTaskStore(temp.tasks).list('session')).resolves.toEqual(before);
        await expect(store.updateMany('session', [])).resolves.toEqual({ ok: false, message: '' });
    });

    it('returns failed items for a mixed batch while later patches see successful earlier patches', async () => {
        const store = createTaskStore(temp.tasks);
        await store.create('session', [{ subject: 'First' }, { subject: 'Second' }]);
        await store.updateMany('session', [{ taskId: '2', addBlockedBy: ['1'] }]);
        const result = await store.updateMany('session', [
            { taskId: 'missing', subject: 'Bad' },
            { taskId: '2', status: 'in_progress', subject: 'must not leak', description: 'must not leak' },
            { taskId: '1', status: 'completed' },
            { taskId: '2', status: 'in_progress', activeForm: 'Working' }
        ]);
        expect(result).toMatchObject({
            ok: true,
            failed: [
                { taskId: 'missing', message: '任务 missing 不存在，请先 TaskList 确认 id' },
                { taskId: '2', message: '任务 2 被未完成的前置任务 [1] 阻塞，请先完成它们' }
            ],
            tasks: [
                { id: '1', status: 'completed', blocks: ['2'] },
                { id: '2', status: 'in_progress', subject: 'Second', activeForm: 'Working', blockedBy: ['1'] }
            ]
        });
        const tasks = await store.list('session');
        expect(tasks[1].description).toBeUndefined();
        await expect(createTaskStore(temp.tasks).list('session')).resolves.toEqual(tasks);
    });

    it('isolates a one-in-progress failure and permits a sequential handoff in the same batch', async () => {
        const store = createTaskStore(temp.tasks);
        await store.create('session', [{ subject: 'One' }, { subject: 'Two' }, { subject: 'Three' }]);
        await store.updateMany('session', [{ taskId: '1', status: 'in_progress' }]);
        const result = await store.updateMany('session', [
            { taskId: '2', status: 'in_progress', addBlocks: ['3'], subject: 'must not leak' },
            { taskId: '1', status: 'completed' },
            { taskId: '2', status: 'in_progress', description: '', activeForm: '' }
        ]);
        expect(result).toMatchObject({
            ok: true,
            failed: [{ taskId: '2', message: '同一时刻最多只能有一个 in_progress 任务' }],
            tasks: [
                { id: '1', status: 'completed' },
                { id: '2', status: 'in_progress', subject: 'Two', description: '', activeForm: '', blocks: [] },
                { id: '3', status: 'pending', blockedBy: [] }
            ]
        });
    });

    it('does not commit task changes or sequence increments on a failed real FS write, then drains the queue', async () => {
        const store = createTaskStore(temp.tasks);
        const before = await store.create('session', [{ subject: 'Original' }]);
        const file = path.join(temp.tasks, 'session.json');
        const original = await fs.readFile(file, 'utf8');
        await fs.rm(file);
        await fs.mkdir(file);
        await expect(store.create('session', [{ subject: 'Rejected' }])).rejects.toThrow();
        await expect(store.list('session')).resolves.toEqual(before);
        await expect(
            store.updateMany('session', [{ taskId: '1', subject: 'Rejected update', status: 'completed' }])
        ).rejects.toThrow();
        await expect(store.list('session')).resolves.toEqual(before);
        expect((await fs.readdir(temp.tasks)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
        await fs.rm(file, { recursive: true });
        await fs.writeFile(file, original);
        const recovered = await store.create('session', [{ subject: 'Recovered' }]);
        expect(recovered.map((t) => t.id)).toEqual(['1', '2']);
        await expect(createTaskStore(temp.tasks).list('session')).resolves.toEqual(recovered);
    });

    it('deletes idempotently, clears the cache and sequence, and preserves other sessions', async () => {
        const store = createTaskStore(temp.tasks);
        await store.create('remove', [{ subject: 'Remove' }]);
        await store.create('keep', [{ subject: 'Keep' }]);
        await store.delete('remove');
        await store.delete('remove');
        await store.delete('missing');
        await expect(fs.stat(path.join(temp.tasks, 'remove.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(store.list('remove')).resolves.toEqual([]);
        await expect(createTaskStore(temp.tasks).list('remove')).resolves.toEqual([]);
        const recreated = await store.create('remove', [{ subject: 'New' }]);
        expect(recreated).toEqual([expect.objectContaining({ id: '1', subject: 'New' })]);
        await expect(store.list('keep')).resolves.toEqual([expect.objectContaining({ id: '1', subject: 'Keep' })]);
    });
});
