import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getMemoryStore, MemoryStore } from '@/modules/memory';

import { createTempData } from '../helpers/temp-data';

describe('MemoryStore', () => {
    it('persists records, reports created state and rebuilds the index', async () => {
        const temp = await createTempData();
        try {
            const store = new MemoryStore(temp.memory);
            await expect(
                store.write({
                    name: 'user-preference',
                    type: 'user',
                    description: '  prefer concise  ',
                    content: '  facts  '
                })
            ).resolves.toMatchObject({ created: true, record: { name: 'user-preference', content: 'facts' } });
            await expect(
                store.write({ name: 'user-preference', type: 'user', description: 'updated', content: 'new facts' })
            ).resolves.toMatchObject({ created: false });
            await expect(store.read('user-preference')).resolves.toMatchObject({
                description: 'updated',
                content: 'new facts'
            });
            await expect(store.list()).resolves.toEqual([
                expect.objectContaining({ name: 'user-preference', type: 'user', description: 'updated' })
            ]);
            await expect(store.readIndex()).resolves.toContain('user-preference');
        } finally {
            await temp.cleanup();
        }
    });

    it('serializes concurrent writes and keeps independent names', async () => {
        const temp = await createTempData();
        try {
            const store = new MemoryStore(temp.memory);
            await Promise.all(
                ['one', 'two', 'three'].map((name) =>
                    store.write({ name, type: 'reference', description: name, content: `${name} content` })
                )
            );
            const names = (await store.list()).map((item) => item.name).sort();
            expect(names).toEqual(['one', 'three', 'two']);
        } finally {
            await temp.cleanup();
        }
    });

    it('rejects path traversal and returns false for missing deletion', async () => {
        const temp = await createTempData();
        try {
            const store = new MemoryStore(temp.memory);
            await expect(
                store.write({ name: '../escape', type: 'user', description: '', content: 'bad' })
            ).rejects.toThrow('非法的记忆名称');
            await expect(store.read('../escape')).resolves.toBeNull();
            await expect(store.delete('missing')).resolves.toBe(false);
        } finally {
            await temp.cleanup();
        }
    });
});

// 以下场景只使用临时文件系统制造失败，不 mock store 或 fs，验证真实队列与索引的一致性。
describe('MemoryStore recovery and manifest consistency', () => {
    it('shares per-root stores but keeps roots isolated, serializes same-name created flags', async () => {
        const temp = await createTempData();
        try {
            const store = getMemoryStore(temp.memory);
            expect(getMemoryStore(temp.memory)).toBe(store);
            expect(getMemoryStore(temp.projects)).not.toBe(store);
            const results = await Promise.all(
                ['first', 'second', 'last'].map((content) =>
                    store.write({ name: 'Shared.MD', type: 'user', description: content, content })
                )
            );
            expect(results.map((result) => result.created)).toEqual([true, false, false]);
            await expect(store.read('shared.md')).resolves.toMatchObject({ name: 'shared', content: 'last' });
            const [deleted, replacement] = await Promise.all([
                store.delete('shared'),
                store.write({ name: 'shared', type: 'feedback', description: 'replacement', content: 'new' })
            ]);
            expect(deleted).toBe(true);
            expect(replacement.created).toBe(true);
            await expect(store.readIndex()).resolves.toContain('[feedback] — replacement');
            expect((await store.list()).map((item) => item.name)).toEqual(['shared']);
            expect(await fs.readdir(temp.memory)).toEqual(['MEMORY.md', 'shared.md']);
        } finally {
            await temp.cleanup();
        }
    });

    it('rebuilds an edited index from records and invalidates warmed manifests on overwrite/delete', async () => {
        const temp = await createTempData();
        try {
            const store = getMemoryStore(temp.memory);
            await expect(store.list()).resolves.toEqual([]);
            await expect(store.readIndex()).resolves.toBe('');
            await store.writeIndex('  manual pointers  ');
            expect(await fs.readFile(path.join(temp.memory, 'MEMORY.md'), 'utf8')).toBe('manual pointers\n');
            await store.write({ name: 'item', type: 'project', description: 'before', content: 'before' });
            await store.list();
            await store.write({ name: 'item', type: 'reference', description: 'after', content: 'after' });
            await expect(store.list()).resolves.toEqual([
                expect.objectContaining({ description: 'after', type: 'reference' })
            ]);
            await expect(store.readIndex()).resolves.not.toContain('manual pointers');
            await expect(store.delete('item')).resolves.toBe(true);
            await expect(store.list()).resolves.toEqual([]);
            await expect(store.readIndex()).resolves.toBe('# Memory');
            await expect(store.delete('item')).resolves.toBe(false);
            await expect(store.delete('../bad')).resolves.toBe(false);
        } finally {
            await temp.cleanup();
        }
    });

    it('recovers its write queue after an atomic rename failure', async () => {
        const temp = await createTempData();
        try {
            const store = getMemoryStore(temp.memory);
            // 目录占用目标文件名使 rename 真实失败；随后移除障碍，下一项应仍能成功。
            await fs.mkdir(path.join(temp.memory, 'blocked.md'), { recursive: true });
            await expect(
                store.write({ name: 'blocked', type: 'user', description: '', content: 'bad' })
            ).rejects.toThrow();
            await fs.rmdir(path.join(temp.memory, 'blocked.md'));
            await expect(
                store.write({ name: 'blocked', type: 'user', description: 'recovered', content: 'good' })
            ).resolves.toMatchObject({ created: true });
            await expect(store.read('blocked')).resolves.toMatchObject({ content: 'good' });
            expect((await fs.readdir(temp.memory)).filter((name) => name.includes('.tmp'))).toEqual([]);
        } finally {
            await temp.cleanup();
        }
    });

    it('recovers after an unwritable root and treats non-file deletion as failure', async () => {
        const temp = await createTempData();
        try {
            await fs.writeFile(temp.memory, 'root is a file');
            const store = getMemoryStore(temp.memory);
            await expect(store.list()).resolves.toEqual([]);
            await expect(store.writeIndex('index')).rejects.toThrow();
            await fs.unlink(temp.memory);
            await fs.mkdir(path.join(temp.memory, 'directory.md'), { recursive: true });
            await expect(store.delete('directory')).resolves.toBe(false);
            await store.writeIndex('recovered');
            await expect(store.readIndex()).resolves.toBe('recovered');
        } finally {
            await temp.cleanup();
        }
    });

    it('skips malformed YAML and unreadable entries but accepts legacy plain Markdown', async () => {
        const temp = await createTempData();
        try {
            await fs.mkdir(temp.memory, { recursive: true });
            await fs.writeFile(path.join(temp.memory, 'broken.md'), '---\nmetadata: [\n---\nbroken');
            await fs.writeFile(path.join(temp.memory, 'legacy.md'), 'legacy facts');
            await fs.writeFile(
                path.join(temp.memory, 'unknown.md'),
                '---\ntype: impossible\ndescription: 42\nmetadata: []\n---\nbody'
            );
            await fs.writeFile(path.join(temp.memory, 'MEMORY.md'), '# Manual index');
            await fs.writeFile(path.join(temp.memory, 'notes.txt'), 'not a memory');
            await fs.mkdir(path.join(temp.memory, 'nested.md'));
            const store = getMemoryStore(temp.memory);
            await expect(store.read('broken')).resolves.toBeNull();
            await expect(store.read('missing')).resolves.toBeNull();
            await expect(store.read('legacy')).resolves.toMatchObject({
                type: 'user',
                name: 'legacy',
                content: 'legacy facts',
                updatedAt: '1970-01-01T00:00:00.000Z'
            });
            await expect(store.read('unknown')).resolves.toMatchObject({
                type: 'user',
                description: '',
                content: 'body'
            });
            const list = await store.list();
            expect(list.map((item) => item.name).sort()).toEqual(['legacy', 'unknown']);
            expect(list.every((item) => Number.isFinite(Date.parse(item.updatedAt)))).toBe(true);
        } finally {
            await temp.cleanup();
        }
    });

    it('caps manifests at the 200 newest records and caches an unchanged directory', async () => {
        const temp = await createTempData();
        try {
            await fs.mkdir(temp.memory, { recursive: true });
            const base = 1_700_000_000;
            await Promise.all(
                Array.from({ length: 202 }, async (_, index) => {
                    const file = path.join(temp.memory, `item-${index}.md`);
                    await fs.writeFile(file, `record ${index}`);
                    await fs.utimes(file, base + index, base + index);
                })
            );
            const store = getMemoryStore(temp.memory);
            const list = await store.list();
            expect(list).toHaveLength(200);
            expect(list[0].name).toBe('item-201');
            expect(list.at(-1)?.name).toBe('item-2');
            expect(await store.list()).toBe(list);
        } finally {
            await temp.cleanup();
        }
    });
});
