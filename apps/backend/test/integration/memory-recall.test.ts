import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    buildMemorySection,
    getMemoryStore,
    memoryItemId,
    projectMemoryRoot,
    recallMemories,
    selectRelevantMemories
} from '@/modules/memory';
import type { TaggedManifestItem } from '@/modules/memory';

import { memoryFixture, resolvedModel, textModel } from './memory-fixtures';

const layers = [{ scope: 'global' as const }, { scope: 'project' as const, projectId: 'demo' }];
const items: TaggedManifestItem[] = Array.from({ length: 9 }, (_, index) => ({
    name: `item-${index}`,
    scope: index === 0 ? 'project' : 'global',
    mtimeMs: index,
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...(index === 0 ? {} : { type: 'reference' as const, description: `summary ${index}` })
}));

describe('memory selector via real AI SDK', () => {
    it('filters unknown/non-string ids, preserves scope and caps selection at five', async () => {
        const model = textModel(
            '结果：[42,"global/unknown","project/item-0","global/item-1","global/item-2","global/item-3","global/item-4","global/item-5"]'
        );
        const signal = new AbortController().signal;
        await expect(
            selectRelevantMemories({
                query: 'workspace reference',
                items,
                model: resolvedModel,
                modelFactory: () => model,
                signal
            })
        ).resolves.toEqual(['project/item-0', 'global/item-1', 'global/item-2', 'global/item-3', 'global/item-4']);
        expect(memoryItemId(items[0])).toBe('project/item-0');
        expect(model.doGenerateCalls).toHaveLength(1);
        const request = model.doGenerateCalls[0];
        expect(request).toMatchObject({ temperature: 0, maxOutputTokens: 256 });
        expect(JSON.stringify(request.prompt)).toContain('project/item-0 [user]');
        expect(JSON.stringify(request.prompt)).toContain('workspace reference');
        expect(request.abortSignal).toBeDefined();
    });

    it.each(['not JSON', '[invalid]', '[]'])('fails closed for model output %s', async (text) => {
        const model = textModel(text);
        await expect(
            selectRelevantMemories({ query: 'q', items, model: resolvedModel, modelFactory: () => model })
        ).resolves.toEqual([]);
    });

    it('avoids model construction without candidates and degrades on model boundary errors', async () => {
        const fail = () => {
            throw new Error('offline');
        };
        await expect(
            selectRelevantMemories({ query: 'q', items: [], model: resolvedModel, modelFactory: fail })
        ).resolves.toEqual([]);
        await expect(
            selectRelevantMemories({ query: 'q', items, model: resolvedModel, modelFactory: fail })
        ).resolves.toEqual([]);
    });

    it('deduplicates model ids before applying the five-memory limit', async () => {
        const model = textModel('["global/item-1","global/item-1","global/item-2"]');
        await expect(
            selectRelevantMemories({ query: 'q', items, model: resolvedModel, modelFactory: () => model })
        ).resolves.toEqual(['global/item-1', 'global/item-2']);
    });
});

describe('memory recall and prompt injection on temporary FS', () => {
    it('returns no content for missing layers and ignores empty default indexes', async () => {
        const fixture = await memoryFixture();
        try {
            await expect(recallMemories({ query: 'q', layers, model: resolvedModel })).resolves.toBe('');
            await expect(buildMemorySection({ layers, recalled: '  ' })).resolves.toBe('');
            await getMemoryStore(fixture.memory).writeIndex('# Memory');
            await expect(buildMemorySection({ layers, recalled: '' })).resolves.toBe('');
            await expect(buildMemorySection({ layers: [], recalled: ' facts ' })).resolves.toContain(
                '### 本轮相关记忆\nfacts'
            );
        } finally {
            await fixture.cleanup();
        }
    });

    it('fast-paths both scopes, strips frontmatter and marks only stale records', async () => {
        const fixture = await memoryFixture();
        try {
            const globalStore = getMemoryStore(fixture.memory);
            const projectStore = getMemoryStore(projectMemoryRoot('demo'));
            await globalStore.write({
                name: 'profile',
                type: 'user',
                description: 'global profile',
                content: 'global facts'
            });
            await projectStore.write({
                name: 'profile',
                type: 'project',
                description: 'project profile',
                content: 'project facts'
            });
            const nowMs = Date.now();
            await fs.utimes(
                path.join(fixture.memory, 'profile.md'),
                (nowMs - 3 * 86_400_000) / 1000,
                (nowMs - 3 * 86_400_000) / 1000
            );
            const model = textModel('[]');
            const recalled = await recallMemories({
                query: 'profile',
                layers,
                model: resolvedModel,
                modelFactory: () => model,
                nowMs
            });
            expect(recalled).toContain('3 天前');
            expect(recalled).toContain('global facts');
            expect(recalled).toContain('project facts');
            expect(recalled).not.toContain('metadata:');
            expect(recalled.match(/可能已过期/gu)).toHaveLength(1);
            expect(model.doGenerateCalls).toHaveLength(0);
            const section = await buildMemorySection({ layers, recalled });
            expect(section).toContain('### 全局记忆索引');
            expect(section).toContain('### 项目记忆索引');
            expect(section).toContain('[profile](profile.md)');
            expect(section).toContain('delete_memory');
            expect(section).toContain('### 本轮相关记忆');
        } finally {
            await fixture.cleanup();
        }
    });

    it('uses the selector for large catalogs and reads only selected files', async () => {
        const fixture = await memoryFixture();
        try {
            const store = getMemoryStore(fixture.memory);
            for (let index = 0; index < 9; index++) {
                await store.write({
                    name: `item-${index}`,
                    type: 'reference',
                    description: 'catalog',
                    content: `fact ${index}`
                });
            }
            const model = textModel('["global/item-4"]');
            const recalled = await recallMemories({
                query: 'specific question',
                layers,
                model: resolvedModel,
                modelFactory: () => model
            });
            expect(recalled).toContain('fact 4');
            expect(recalled).not.toContain('fact 3');
            expect(model.doGenerateCalls).toHaveLength(1);
            const empty = textModel('[]');
            await expect(
                recallMemories({ query: 'q', layers, model: resolvedModel, modelFactory: () => empty })
            ).resolves.toBe('');
            const all = await recallMemories({ query: ' ', layers, model: resolvedModel, modelFactory: () => empty });
            expect(all).toContain('fact 0');
            expect(all).toContain('fact 8');
            expect(empty.doGenerateCalls).toHaveLength(1);
        } finally {
            await fixture.cleanup();
        }
    });

    it('bounds lines and bytes, skips empty/corrupt/deleted files without losing good memories', async () => {
        const fixture = await memoryFixture();
        try {
            const store = getMemoryStore(fixture.memory);
            await store.write({
                name: 'lines',
                type: 'reference',
                description: '',
                content: Array.from({ length: 210 }, (_, i) => `row-${i}`).join('\r\n')
            });
            await store.write({ name: 'bytes', type: 'reference', description: '', content: 'x'.repeat(6000) });
            await store.write({ name: 'empty', type: 'reference', description: '', content: '' });
            await store.write({ name: 'corrupt', type: 'reference', description: '', content: 'once valid' });
            await store.write({ name: 'deleted', type: 'reference', description: '', content: 'once present' });
            await store.list();
            const dirTime = await fs.stat(fixture.memory);
            await fs.writeFile(path.join(fixture.memory, 'corrupt.md'), '---\ninvalid: [\n---\nbad YAML');
            await fs.unlink(path.join(fixture.memory, 'deleted.md'));
            // 保持目录时间，重现「清单扫描之后、正文读取之前」文件被移除的真实 FS 竞态。
            await fs.utimes(fixture.memory, dirTime.atime, dirTime.mtime);
            const recalled = await recallMemories({ query: '', layers, model: resolvedModel });
            expect(recalled).toContain('row-199');
            expect(recalled).not.toContain('row-200');
            expect(recalled).toContain('x'.repeat(4096));
            expect(recalled).not.toContain('x'.repeat(4097));
            expect(recalled).not.toContain('记忆 empty:');
            expect(recalled).not.toContain('bad YAML');
            expect(recalled).not.toContain('once present');
        } finally {
            await fixture.cleanup();
        }
    });

    it('enforces the total recall budget even for blank-query catalogs', async () => {
        const fixture = await memoryFixture();
        try {
            const store = getMemoryStore(fixture.memory);
            for (let index = 0; index < 10; index++)
                await store.write({
                    name: `large-${index}`,
                    type: 'reference',
                    description: '',
                    content: 'x'.repeat(4096)
                });
            const recalled = await recallMemories({ query: '', layers, model: resolvedModel });
            expect(recalled.match(/记忆 large-/gu)).toHaveLength(8);
            expect(recalled.match(/x/gu)).toHaveLength(32_768);
        } finally {
            await fixture.cleanup();
        }
    });
});
