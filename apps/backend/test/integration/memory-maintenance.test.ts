import fs from 'node:fs/promises';
import path from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { createMemoryMaintenance, getMemoryStore, projectMemoryRoot } from '@/modules/memory';

import { deferred, generated, memoryFixture, resolvedModel, textModel } from './memory-fixtures';

const transcript = [{ role: 'user' as const, content: 'I prefer concise explanations' }];
const noAuto = { enabled: true, autoExtract: false, autoDream: false };
const autoExtract = { ...noAuto, autoExtract: true };

async function seed(root: string) {
    const store = getMemoryStore(root);
    for (const name of ['one', 'two', 'three']) {
        await store.write({ name, type: 'reference', description: `summary ${name}`, content: `facts ${name}` });
    }
    return store;
}

describe('memory maintenance with AI SDK model boundary and real FS', () => {
    it('skips disabled, unconfigured, non-substantial and extraction-disabled runs', async () => {
        const fixture = await memoryFixture();
        try {
            const model = textModel('[]');
            for (const settings of [{ ...autoExtract, enabled: false }, noAuto, autoExtract]) {
                const runner = createMemoryMaintenance({
                    getSettings: () => settings,
                    getModel: () => resolvedModel,
                    modelFactory: () => model
                });
                await runner.runMemoryMaintenance({
                    transcript: [
                        { role: 'user', content: 'hi' },
                        { role: 'assistant', content: 'assistant prose is not user prose' }
                    ]
                });
            }
            const missing = createMemoryMaintenance({
                getSettings: () => autoExtract,
                getModel: () => null,
                modelFactory: () => model
            });
            await missing.runMemoryMaintenance({ transcript });
            await missing.runMemoryDream({ force: true });
            await createMemoryMaintenance({
                getSettings: () => ({ ...noAuto, enabled: false }),
                modelFactory: () => model
            }).runMemoryDream({ force: true });
            expect(model.doGenerateCalls).toHaveLength(0);
            await expect(fs.stat(fixture.memory)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await fixture.cleanup();
        }
    });

    it('extracts scoped writes/deletes, skips invalid ops and persists origin session', async () => {
        const fixture = await memoryFixture();
        try {
            const global = getMemoryStore(fixture.memory);
            await global.write({ name: 'old', type: 'feedback', description: 'obsolete', content: 'old facts' });
            const project = getMemoryStore(projectMemoryRoot('demo'));
            await project.write({
                name: 'existing',
                type: 'project',
                description: 'project summary',
                content: 'existing project'
            });
            const model = textModel(
                JSON.stringify([
                    { action: 'delete', scope: 'global', name: 'old' },
                    { action: 'write', scope: 'global', name: '../bad', type: 'user', content: 'unsafe' },
                    { action: 'write', scope: 'global', name: 'empty', type: 'user', content: ' ' },
                    {
                        action: 'write',
                        scope: 'project',
                        name: 'preference',
                        type: 'feedback',
                        description: 'concise',
                        content: 'use short explanations'
                    }
                ])
            );
            const runner = createMemoryMaintenance({
                getSettings: () => autoExtract,
                getModel: () => resolvedModel,
                modelFactory: () => model
            });
            await runner.runMemoryMaintenance({
                transcript: [...transcript, { role: 'assistant', content: 'I will be concise.' }],
                sessionId: 'session',
                projectId: 'demo'
            });
            await expect(global.read('old')).resolves.toBeNull();
            await expect(project.read('preference')).resolves.toMatchObject({
                type: 'feedback',
                originSessionId: 'session',
                content: 'use short explanations'
            });
            expect((await global.list()).map((item) => item.name)).toEqual([]);
            const call = model.doGenerateCalls[0];
            expect(call).toMatchObject({ temperature: 0, maxOutputTokens: 1024 });
            const prompt = JSON.stringify(call.prompt);
            expect(prompt).toContain('[global/feedback] old: obsolete');
            expect(prompt).toContain('[project/project] existing: project summary');
            expect(prompt).toContain('用户：I prefer concise explanations');
            expect(prompt).toContain('助手：I will be concise.');
        } finally {
            await fixture.cleanup();
        }
    });

    it('caps transcript, falls back to global without a project and ignores empty/failed generations', async () => {
        const fixture = await memoryFixture();
        try {
            const model = textModel('[{"name":"prefs","scope":"project","type":"user","content":"concise"}]');
            const runner = createMemoryMaintenance({
                getSettings: () => autoExtract,
                getModel: () => resolvedModel,
                modelFactory: () => model
            });
            await runner.runMemoryMaintenance({
                transcript: [{ role: 'user', content: `removed prefix ${'x'.repeat(13_000)} keep suffix` }]
            });
            await expect(getMemoryStore(fixture.memory).read('prefs')).resolves.toMatchObject({ content: 'concise' });
            const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
            expect(prompt).not.toContain('removed prefix');
            expect(prompt).toContain('keep suffix');
            expect(prompt).toContain('global 层暂无记忆');
            const empty = textModel('[]');
            await createMemoryMaintenance({
                getSettings: () => autoExtract,
                getModel: () => resolvedModel,
                modelFactory: () => empty
            }).runMemoryMaintenance({ transcript });
            const fail = createMemoryMaintenance({
                getSettings: () => autoExtract,
                getModel: () => resolvedModel,
                modelFactory: () => {
                    throw new Error('offline');
                }
            });
            await expect(fail.runMemoryMaintenance({ transcript })).resolves.toBeUndefined();
        } finally {
            await fixture.cleanup();
        }
    });

    it('guards extraction per session while allowing independent sessions and later rounds', async () => {
        const fixture = await memoryFixture();
        const release = deferred<void>();
        const entered = deferred<void>();
        try {
            const model = new MockLanguageModelV4({
                doGenerate: async () => {
                    entered.resolve();
                    await release.promise;
                    return generated('[]');
                }
            });
            const runner = createMemoryMaintenance({
                getSettings: () => autoExtract,
                getModel: () => resolvedModel,
                modelFactory: () => model
            });
            const first = runner.runMemoryMaintenance({ transcript });
            await entered.promise;
            const same = runner.runMemoryMaintenance({ transcript });
            const other = runner.runMemoryMaintenance({ transcript, sessionId: 'other' });
            release.resolve();
            await Promise.all([first, same, other]);
            expect(model.doGenerateCalls).toHaveLength(2);
            await runner.runMemoryMaintenance({ transcript });
            expect(model.doGenerateCalls).toHaveLength(3);
        } finally {
            release.resolve();
            await fixture.cleanup();
        }
    });

    it('serializes forced dream requests before asynchronous lock acquisition', async () => {
        const fixture = await memoryFixture();
        try {
            await seed(fixture.memory);
            const model = textModel('[]');
            const runner = createMemoryMaintenance({
                getSettings: () => noAuto,
                getModel: () => resolvedModel,
                modelFactory: () => model
            });
            await Promise.all([runner.runMemoryDream({ force: true }), runner.runMemoryDream({ force: true })]);
            expect(model.doGenerateCalls).toHaveLength(1);
        } finally {
            await fixture.cleanup();
        }
    });

    it('consolidates both layers, overrides returned scope and permits repeated forced runs of its own lock', async () => {
        const fixture = await memoryFixture();
        try {
            const global = await seed(fixture.memory);
            const project = await seed(projectMemoryRoot('demo'));
            const model = textModel(
                '[{"action":"delete","scope":"global","name":"one"},{"action":"write","scope":"project","name":"two","type":"reference","description":"merged","content":"merged facts"}]'
            );
            const runner = createMemoryMaintenance({
                getSettings: () => noAuto,
                getModel: () => resolvedModel,
                modelFactory: () => model
            });
            await runner.runMemoryDream({ force: true, projectId: 'demo' });
            for (const store of [global, project]) {
                await expect(store.read('one')).resolves.toBeNull();
                await expect(store.read('two')).resolves.toMatchObject({
                    description: 'merged',
                    content: 'merged facts'
                });
            }
            expect(model.doGenerateCalls).toHaveLength(2);
            expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain('当前层：global');
            expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('当前层：project');
            expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain('facts three');
            expect(model.doGenerateCalls[0].maxOutputTokens).toBe(2048);
            await global.write({ name: 'four', type: 'user', description: '', content: 'four facts' });
            await runner.runMemoryDream({ force: true });
            expect(model.doGenerateCalls).toHaveLength(3);
            expect(await fs.readFile(path.join(fixture.memory, '.consolidate-lock'), 'utf8')).toBe(String(process.pid));
        } finally {
            await fixture.cleanup();
        }
    });

    it('honors daily interval and scan throttle without global resets', async () => {
        const fixture = await memoryFixture();
        try {
            await seed(fixture.memory);
            const model = textModel('[]');
            const runner = createMemoryMaintenance({
                getSettings: () => noAuto,
                getModel: () => resolvedModel,
                modelFactory: () => model
            });
            const lock = path.join(fixture.memory, '.consolidate-lock');
            await fs.writeFile(lock, String(process.pid));
            await runner.runMemoryDream();
            expect(model.doGenerateCalls).toHaveLength(0);
            await fs.unlink(lock);
            await runner.runMemoryDream();
            expect(model.doGenerateCalls).toHaveLength(0);
            // 新实例无扫描节流；磁盘没有近期整理记录，应立即执行一次。
            await createMemoryMaintenance({
                getSettings: () => noAuto,
                getModel: () => resolvedModel,
                modelFactory: () => model
            }).runMemoryDream();
            expect(model.doGenerateCalls).toHaveLength(1);
        } finally {
            await fixture.cleanup();
        }
    });

    it('ignores model errors and releases the running guard for the next attempt', async () => {
        const fixture = await memoryFixture();
        try {
            await seed(fixture.memory);
            let calls = 0;
            const model = textModel('[]');
            const runner = createMemoryMaintenance({
                getSettings: () => noAuto,
                getModel: () => resolvedModel,
                modelFactory: () => {
                    calls++;
                    if (calls === 1) throw new Error('offline');
                    return model;
                }
            });
            await expect(runner.runMemoryDream({ force: true })).resolves.toBeUndefined();
            await runner.runMemoryDream({ force: true });
            expect(calls).toBe(2);
            expect(model.doGenerateCalls).toHaveLength(1);
        } finally {
            await fixture.cleanup();
        }
    });

    it('delegates auto dream with extraction disabled and skips layers below minimum size', async () => {
        const fixture = await memoryFixture();
        try {
            const model = textModel('[]');
            let modelReads = 0;
            const runner = createMemoryMaintenance({
                getSettings: () => ({ ...noAuto, autoDream: true }),
                // 第二次读取来自自动 dream；此处关闭模型，使 fire-and-forget 同步退出，清理不与后台 FS 竞争。
                getModel: () => (++modelReads === 1 ? resolvedModel : null),
                modelFactory: () => model
            });
            await runner.runMemoryMaintenance({ transcript });
            expect(modelReads).toBe(2);
            const empty = createMemoryMaintenance({
                getSettings: () => noAuto,
                getModel: () => resolvedModel,
                modelFactory: () => model
            });
            await empty.runMemoryDream({ force: true });
            expect(await fs.readFile(path.join(fixture.memory, '.consolidate-lock'), 'utf8')).toBe(String(process.pid));
            expect(model.doGenerateCalls).toHaveLength(0);
        } finally {
            await fixture.cleanup();
        }
    });
});
