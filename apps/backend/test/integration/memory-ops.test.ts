import { describe, expect, it } from 'vitest';

import {
    applyMemoryOps,
    getMemoryStore,
    globalMemoryRoot,
    isMemoryScope,
    isMemoryType,
    parseMemoryOps,
    projectMemoryRoot,
    projectsMemoryParent,
    resolveMemoryRoot,
    sanitizeMemoryName
} from '@/modules/memory';

import { memoryFixture } from './memory-fixtures';

describe('memory operations and scope contract', () => {
    it('validates scope/type, normalizes slugs and confines project roots to temporary data', async () => {
        const fixture = await memoryFixture();
        try {
            expect(globalMemoryRoot()).toBe(fixture.memory);
            expect(projectsMemoryParent()).toBe(fixture.projects);
            expect(resolveMemoryRoot('project')).toBe(fixture.memory);
            expect(resolveMemoryRoot('project', 'demo')).toBe(projectMemoryRoot('demo'));
            expect(projectMemoryRoot('../demo/path')).toBe(`${fixture.projects}/demo-path/memory`);
            expect(sanitizeMemoryName('  My Notes.MD ')).toBe('my-notes');
            expect(sanitizeMemoryName('a'.repeat(80))).toHaveLength(64);
            for (const name of ['', '...', '中文', 'dir\\file', '../escape']) expect(sanitizeMemoryName(name)).toBe('');
            for (const type of ['user', 'feedback', 'project', 'reference']) expect(isMemoryType(type)).toBe(true);
            for (const type of [null, 1, 'unknown']) expect(isMemoryType(type)).toBe(false);
            expect(isMemoryScope('global')).toBe(true);
            expect(isMemoryScope('project')).toBe(true);
            expect(isMemoryScope('user')).toBe(false);
        } finally {
            await fixture.cleanup();
        }
    });

    it('parses only supported actions and types with deterministic defaults', () => {
        expect(parseMemoryOps('[broken]', true)).toEqual([]);
        expect(parseMemoryOps('no JSON', true)).toEqual([]);
        expect(
            parseMemoryOps(
                '[null,42,"text",{}, {"name":5}, {"name":"bad","action":"rename","type":"user"}, {"name":"bad-type","type":"bogus"}]',
                true
            )
        ).toEqual([]);
        expect(
            parseMemoryOps(
                '[{"name":"default","type":"user"},{"name":"remove","action":"delete","scope":"project"},{"name":"write","action":"write","type":"feedback","scope":"invalid","description":5,"content":false}]',
                true
            )
        ).toEqual([
            { action: 'write', scope: 'global', name: 'default', type: 'user', description: '', content: '' },
            { action: 'delete', scope: 'project', name: 'remove' },
            { action: 'write', scope: 'global', name: 'write', type: 'feedback', description: '', content: '' }
        ]);
        expect(parseMemoryOps('[{"name":"remove","action":"delete","scope":"project"}]', false)).toEqual([
            { action: 'delete', scope: 'global', name: 'remove' }
        ]);
    });

    it('applies in order, counts only completed operations and isolates scope/session metadata', async () => {
        const fixture = await memoryFixture();
        try {
            const result = await applyMemoryOps(
                [
                    {
                        action: 'write',
                        scope: 'global',
                        name: 'facts',
                        type: 'user',
                        description: 'global',
                        content: 'global facts'
                    },
                    {
                        action: 'write',
                        scope: 'project',
                        name: 'facts',
                        type: 'project',
                        description: 'project',
                        content: 'project facts'
                    },
                    { action: 'delete', scope: 'global', name: 'facts' },
                    { action: 'delete', scope: 'global', name: 'missing' },
                    { action: 'delete', scope: 'project', name: '../bad' },
                    { action: 'write', scope: 'global', name: 'empty', type: 'user', description: '', content: '\n ' },
                    {
                        action: 'write',
                        scope: 'global',
                        name: '../bad',
                        type: 'user',
                        description: '',
                        content: 'invalid'
                    },
                    {
                        action: 'write',
                        scope: 'global',
                        name: 'later',
                        type: 'reference',
                        description: '',
                        content: 'valid after failure'
                    }
                ],
                { projectId: 'demo', sessionId: 'test-session' }
            );
            expect(result).toEqual({ written: 3, deleted: 1 });
            await expect(getMemoryStore(fixture.memory).read('facts')).resolves.toBeNull();
            await expect(getMemoryStore(projectMemoryRoot('demo')).read('facts')).resolves.toMatchObject({
                content: 'project facts',
                originSessionId: 'test-session'
            });
            await expect(getMemoryStore(fixture.memory).read('later')).resolves.toMatchObject({
                content: 'valid after failure'
            });
        } finally {
            await fixture.cleanup();
        }
    });
});
