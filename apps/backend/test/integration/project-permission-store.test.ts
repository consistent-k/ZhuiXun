import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPermissionStore } from '@/modules/permission';
import type { SavedProject } from '@/modules/projects';
import { createProjectStore, isValidProjectId } from '@/modules/projects';

import type { TempData } from '../helpers/temp-data';
import { createTempData } from '../helpers/temp-data';

describe('factory-created stores', () => {
    it('keeps project roots normalized in a temporary store', async () => {
        const temp = await createTempData();
        try {
            const store = createProjectStore(temp.projects);
            await store.upsert('project-1', {
                name: 'Demo',
                roots: [{ path: '/tmp/secondary' }, { path: '/tmp/primary', primary: true }]
            });
            await expect(store.get('project-1')).resolves.toMatchObject({
                roots: [
                    { path: '/tmp/secondary', primary: false },
                    { path: '/tmp/primary', primary: true }
                ]
            });
        } finally {
            await temp.cleanup();
        }
    });

    it('persists permission rules only in the injected file', async () => {
        const temp = await createTempData();
        try {
            const file = path.join(temp.permissions, 'permissions.json');
            const store = createPermissionStore(file);
            await expect(store.remember({ command: 'git status', scope: 'permanent' })).resolves.toMatchObject({
                rule: { head: 'git status' }
            });
            await expect(store.resolveBashApproval('git status')).resolves.toBe('approved');
            const second = createPermissionStore(file);
            await expect(second.resolveBashApproval('git status')).resolves.toBe('approved');
        } finally {
            await temp.cleanup();
        }
    });
});

describe('ProjectStore', () => {
    let temp: TempData;
    beforeEach(async () => {
        temp = await createTempData();
    });
    afterEach(async () => {
        await temp.cleanup();
    });

    async function seedProject(id: string, patch: Partial<SavedProject> = {}): Promise<SavedProject> {
        const project: SavedProject = {
            version: 1,
            id,
            name: id,
            createdAt: 10,
            updatedAt: 10,
            ...patch
        };
        const dir = path.join(temp.projects, id);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(project));
        return project;
    }

    it('keeps empty reads non-writing and rejects unsafe ids across every operation', async () => {
        const store = createProjectStore(temp.projects);
        await expect(store.list()).resolves.toEqual([]);
        await expect(store.get('missing')).resolves.toBeNull();
        for (const id of ['', '../escape', 'with space', 'a'.repeat(129)]) {
            expect(isValidProjectId(id)).toBe(false);
            await expect(store.get(id)).resolves.toBeNull();
            await expect(store.upsert(id, { name: 'bad' })).rejects.toThrow('非法项目 id');
            await expect(store.softDelete(id)).resolves.toBeUndefined();
            await expect(store.restore(id)).resolves.toBeNull();
            await expect(store.hardDelete(id)).resolves.toBeUndefined();
        }
        expect(isValidProjectId('a_0-Z')).toBe(true);
        expect(isValidProjectId('a'.repeat(128))).toBe(true);
        await expect(fs.stat(temp.projects)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('preserves creation metadata and optional fields, while supporting explicit false and empty roots', async () => {
        const store = createProjectStore(temp.projects);
        const created = await store.upsert('demo', {
            name: 'First',
            icon: 'folder',
            color: 'blue',
            archived: true,
            instructions: 'Follow evidence',
            defaultSkillId: 'research',
            skillPreset: ['research'],
            roots: [{ path: temp.root }],
            trusted: true,
            createdAt: 123
        });
        expect(created).toMatchObject({ id: 'demo', createdAt: 123, roots: [{ path: temp.root, primary: true }] });
        expect(created.updatedAt).toEqual(expect.any(Number));
        expect(created).not.toHaveProperty('instructions');
        expect(created).not.toHaveProperty('skillPreset');
        await store.upsert('demo', { name: 'Renamed', createdAt: 999 });
        await expect(store.get('demo')).resolves.toMatchObject({
            name: 'Renamed',
            createdAt: 123,
            icon: 'folder',
            color: 'blue',
            archived: true,
            instructions: 'Follow evidence',
            defaultSkillId: 'research',
            skillPreset: ['research'],
            roots: [{ path: temp.root, primary: true }],
            trusted: true
        });
        await store.upsert('demo', { name: 'Cleared', archived: false, trusted: false, roots: [], instructions: '' });
        const reloaded = createProjectStore(temp.projects);
        await expect(reloaded.get('demo')).resolves.toMatchObject({
            name: 'Cleared',
            createdAt: 123,
            archived: false,
            trusted: false,
            roots: [],
            instructions: ''
        });
        await expect(reloaded.list()).resolves.toEqual([
            expect.objectContaining({ id: 'demo', name: 'Cleared', roots: [], trusted: false })
        ]);
    });

    it.each(['missing', 'malformed'])(
        'rebuilds a %s index and skips unrelated or corrupt project entries',
        async (kind) => {
            await seedProject('older', { updatedAt: 10 });
            await seedProject('newer', { updatedAt: 30, deleted: true, deletedAt: 31 });
            await seedProject('middle', { updatedAt: 20 });
            await fs.writeFile(path.join(temp.projects, 'notes.txt'), 'unrelated file');
            await fs.mkdir(path.join(temp.projects, 'without-project'));
            await fs.mkdir(path.join(temp.projects, 'corrupt'));
            await fs.writeFile(path.join(temp.projects, 'corrupt', 'project.json'), '{broken');
            if (kind === 'malformed') await fs.writeFile(path.join(temp.projects, 'index.json'), '{broken');
            const store = createProjectStore(temp.projects);
            expect((await store.list()).map((p) => p.id)).toEqual(['middle', 'older']);
            expect((await store.list({ includeDeleted: true })).map((p) => p.id)).toEqual(['newer', 'middle', 'older']);
            if (kind === 'malformed') {
                expect(await fs.readFile(path.join(temp.projects, 'index.json'), 'utf8')).toBe('{broken');
            } else {
                await expect(fs.stat(path.join(temp.projects, 'index.json'))).rejects.toMatchObject({ code: 'ENOENT' });
            }
            await store.upsert('added', { name: 'Added' });
            expect((await createProjectStore(temp.projects).list({ includeDeleted: true })).map((p) => p.id)).toEqual([
                'added',
                'newer',
                'middle',
                'older'
            ]);
            await expect(store.get('corrupt')).rejects.toBeInstanceOf(SyntaxError);
        }
    );

    it('propagates an unreadable storage root rather than treating it as an empty directory', async () => {
        await fs.writeFile(temp.projects, 'this is a file');
        await expect(createProjectStore(temp.projects).list()).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('soft deletes without removing project memory, preserves deletion on upsert, and restores idempotently', async () => {
        const store = createProjectStore(temp.projects);
        await store.upsert('demo', { name: 'Demo' });
        const memoryFile = path.join(temp.projects, 'demo', 'memory', 'note.md');
        await fs.mkdir(path.dirname(memoryFile));
        await fs.writeFile(memoryFile, 'project memory');
        await store.softDelete('demo');
        await store.softDelete('demo');
        await expect(store.list()).resolves.toEqual([]);
        const deleted = await store.get('demo');
        expect(deleted).toMatchObject({ deleted: true, deletedAt: expect.any(Number) });
        await store.upsert('demo', { name: 'Still deleted' });
        await expect(store.get('demo')).resolves.toMatchObject({
            deleted: true,
            deletedAt: deleted!.deletedAt,
            name: 'Still deleted'
        });
        await expect(store.list({ includeDeleted: true })).resolves.toHaveLength(1);
        expect(await fs.readFile(memoryFile, 'utf8')).toBe('project memory');
        const restored = await store.restore('demo');
        expect(restored).toMatchObject({ id: 'demo', deleted: undefined, deletedAt: undefined });
        await expect(store.restore('demo')).resolves.toMatchObject({ id: 'demo' });
        const fresh = createProjectStore(temp.projects);
        await expect(fresh.list()).resolves.toHaveLength(1);
        const restoredOnDisk = await fresh.get('demo');
        expect(restoredOnDisk).not.toHaveProperty('deleted');
        expect(restoredOnDisk).not.toHaveProperty('deletedAt');
        await expect(store.softDelete('missing')).resolves.toBeUndefined();
        await expect(store.restore('missing')).resolves.toBeNull();
    });

    it('hard deletes the entire project directory and retains other projects across reopen', async () => {
        const store = createProjectStore(temp.projects);
        await store.upsert('remove', { name: 'Remove' });
        await store.upsert('keep', { name: 'Keep' });
        const memory = path.join(temp.projects, 'remove', 'memory');
        await fs.mkdir(memory);
        await fs.writeFile(path.join(memory, 'note.md'), 'project memory');
        await store.hardDelete('remove');
        await store.hardDelete('remove');
        await expect(fs.stat(path.join(temp.projects, 'remove'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(store.get('remove')).resolves.toBeNull();
        await expect(createProjectStore(temp.projects).list()).resolves.toEqual([
            expect.objectContaining({ id: 'keep' })
        ]);
    });

    it('serializes concurrent creates and same-project patches without losing metadata or index entries', async () => {
        const store = createProjectStore(temp.projects);
        await Promise.all(Array.from({ length: 8 }, (_, i) => store.upsert(`project-${i}`, { name: `Project ${i}` })));
        await Promise.all([
            store.upsert('project-0', { name: 'First patch', instructions: 'retain me' }),
            store.upsert('project-0', { name: 'Last patch', trusted: true })
        ]);
        await expect(store.list()).resolves.toHaveLength(8);
        const reopened = createProjectStore(temp.projects);
        await expect(reopened.list()).resolves.toHaveLength(8);
        await expect(reopened.get('project-0')).resolves.toMatchObject({
            name: 'Last patch',
            instructions: 'retain me',
            trusted: true
        });
    });

    it('keeps the index cache unchanged on project-file read failure and continues its queue', async () => {
        const store = createProjectStore(temp.projects);
        await store.upsert('blocked', { name: 'Before' });
        const before = await store.list();
        const file = path.join(temp.projects, 'blocked', 'project.json');
        const original = await fs.readFile(file, 'utf8');
        await fs.rm(file);
        await fs.mkdir(file);
        await expect(store.upsert('blocked', { name: 'Rejected' })).rejects.toThrow();
        await expect(store.list()).resolves.toEqual(before);
        await fs.rm(file, { recursive: true });
        await fs.writeFile(file, original);
        await store.upsert('blocked', { name: 'Recovered' });
        await expect(createProjectStore(temp.projects).get('blocked')).resolves.toMatchObject({ name: 'Recovered' });
    });

    it('does not publish a failed index write to cache, then recovers after the real FS obstruction is removed', async () => {
        const store = createProjectStore(temp.projects);
        await store.upsert('demo', { name: 'Before' });
        const before = await store.list();
        const indexFile = path.join(temp.projects, 'index.json');
        await fs.rm(indexFile);
        await fs.mkdir(indexFile);
        await expect(store.upsert('demo', { name: 'Unindexed' })).rejects.toThrow();
        await expect(store.list()).resolves.toEqual(before);
        expect((await fs.readdir(temp.projects)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
        await fs.rm(indexFile, { recursive: true });
        await store.upsert('demo', { name: 'Recovered' });
        await expect(createProjectStore(temp.projects).list()).resolves.toEqual([
            expect.objectContaining({ id: 'demo', name: 'Recovered' })
        ]);
    });
});
