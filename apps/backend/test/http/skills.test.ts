import type { Tool } from 'ai';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/http/middleware/error-handler';
import { createDebugRouter } from '@/http/routes/debug';
import { createSkillsRouter } from '@/http/routes/skills';
import type { LoadedSkill, SkillMetadata } from '@/modules/skills';

const metadata: SkillMetadata = {
    id: 'demo',
    name: 'Demo',
    description: 'Description',
    dirPath: '/fake',
    loaded: true,
    source: 'user',
    editable: true,
    disabled: false,
    triggers: ['trigger']
};
const loaded: LoadedSkill = {
    id: 'demo',
    name: 'Demo',
    description: 'Description',
    systemPrompt: 'Prompt',
    tools: { lookup: {} as Tool },
    toolInfo: [{ name: 'lookup', description: 'Look up' }]
};
const registry = {
    listMetadata: vi.fn(),
    loadAll: vi.fn(),
    listLoaded: vi.fn(),
    getMetadataById: vi.fn(),
    getSkillSource: vi.fn(),
    get: vi.fn(),
    hasUserDir: vi.fn(),
    createUserSkill: vi.fn(),
    updateUserSkill: vi.fn(),
    removeUserSkill: vi.fn(),
    toggleSkill: vi.fn(),
    importSkill: vi.fn(),
    exportSkill: vi.fn()
} satisfies NonNullable<ReturnType<Parameters<typeof createSkillsRouter>[0]>>;
let ready = true;
const app = new Hono();
app.route(
    '/',
    createSkillsRouter(() => (ready ? registry : undefined))
);
app.route(
    '/',
    createDebugRouter(() => (ready ? registry : undefined))
);
app.onError(errorHandler);
const input = {
    name: 'demo',
    description: ' Description ',
    systemPrompt: ' Prompt ',
    displayName: ' Display ',
    triggers: [' valid ', 1, ''],
    allowedTools: ['Read', null, ''],
    disallowedTools: ['Write']
};
async function req(url: string, method = 'GET', body?: unknown, status = 200) {
    const response = await app.request(`/api/${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    expect(response.status).toBe(status);
    const result = (await response.json()) as { code: number; data: unknown; message?: string };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result;
}
async function upload(name: string | undefined, url = 'skills/upload', status = 200) {
    const body = new FormData();
    if (name !== undefined) body.append('file', new File(['skill content'], name));
    const response = await app.request(`/api/${url}`, { method: 'POST', body });
    expect(response.status).toBe(status);
    const result = (await response.json()) as { code: number; data: unknown };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result;
}
beforeEach(() => {
    vi.resetAllMocks();
    ready = true;
    registry.listMetadata.mockReturnValue([metadata, { ...metadata, id: 'empty' }]);
    registry.listLoaded.mockReturnValue([loaded]);
    registry.loadAll.mockResolvedValue([loaded]);
    registry.getMetadataById.mockReturnValue(metadata);
    registry.getSkillSource.mockResolvedValue({
        ...input,
        triggers: ['trigger'],
        allowedTools: ['Read'],
        disallowedTools: ['Write']
    });
    registry.get.mockResolvedValue(loaded);
    registry.hasUserDir.mockReturnValue(true);
    registry.createUserSkill.mockResolvedValue(metadata);
    registry.updateUserSkill.mockResolvedValue(metadata);
    registry.toggleSkill.mockResolvedValue(true);
    registry.importSkill.mockResolvedValue('demo');
    registry.exportSkill.mockResolvedValue(new Uint8Array([80, 75]));
});

describe('skills and debug real Hono routers', () => {
    it('covers every route readiness gate and read-only user directory gate', async () => {
        ready = false;
        for (const [url, method] of [
            ['skills', 'GET'],
            ['skills/demo', 'GET'],
            ['skills', 'POST'],
            ['skills/demo', 'PUT'],
            ['skills/demo', 'DELETE'],
            ['skills/demo/toggle', 'PATCH'],
            ['skills/demo/export', 'GET'],
            ['debug/tools', 'GET']
        ])
            await req(url!, method!, undefined, 503);
        await upload(undefined, 'skills/upload', 503);
        ready = true;
        registry.hasUserDir.mockReturnValue(false);
        await req('skills', 'POST', input, 403);
        await upload('demo.md', 'skills/import', 403);
    });

    it('lists metadata with loaded tools, falls back after load failure, and debug counts actual tools', async () => {
        expect((await req('skills')).data).toEqual([
            {
                id: 'demo',
                name: 'Demo',
                description: 'Description',
                source: 'user',
                editable: true,
                disabled: false,
                tools: [{ name: 'lookup', description: 'Look up' }]
            },
            {
                id: 'empty',
                name: 'Demo',
                description: 'Description',
                source: 'user',
                editable: true,
                disabled: false,
                tools: []
            }
        ]);
        registry.loadAll.mockRejectedValueOnce(new Error('load failed'));
        expect((await req('skills')).data).toHaveLength(2);
        registry.loadAll.mockResolvedValueOnce([loaded, { ...loaded, id: 'no-tools', tools: undefined }]);
        expect((await req('debug/tools')).data).toEqual({
            totalSkills: 2,
            totalTools: 1,
            skills: [
                { skillId: 'demo', skillName: 'Demo', tools: ['lookup'], toolCount: 1 },
                { skillId: 'no-tools', skillName: 'Demo', tools: [], toolCount: 0 }
            ]
        });
        registry.loadAll.mockRejectedValueOnce(new Error('dependency failed'));
        await req('debug/tools', 'GET', undefined, 500);
    });

    it('details prefer editable source, fall back to metadata, and distinguish missing/load failures', async () => {
        expect((await req('skills/demo')).data).toMatchObject({
            id: 'demo',
            systemPrompt: ' Prompt ',
            displayName: ' Display ',
            triggers: ['trigger'],
            allowedTools: ['Read'],
            tools: [{ name: 'lookup', description: 'Look up' }]
        });
        registry.getSkillSource.mockResolvedValueOnce(null);
        registry.get.mockResolvedValueOnce(undefined);
        expect((await req('skills/demo')).data).toMatchObject({
            description: 'Description',
            triggers: ['trigger'],
            systemPrompt: '',
            tools: []
        });
        registry.getMetadataById.mockReturnValueOnce(undefined);
        await req('skills/missing', 'GET', undefined, 404);
        registry.getSkillSource.mockRejectedValueOnce(new Error('disk failed'));
        expect((await req('skills/demo', 'GET', undefined, 500)).message).toBe('读取技能详情失败');
    });

    it('validates/normalizes create and edit bodies; delete/toggle preserve IDs', async () => {
        expect((await req('skills', 'POST', input)).data).toEqual({ id: 'demo' });
        expect(registry.createUserSkill).toHaveBeenLastCalledWith({
            name: 'demo',
            description: 'Description',
            systemPrompt: 'Prompt',
            displayName: 'Display',
            triggers: [' valid '],
            allowedTools: ['Read'],
            disallowedTools: ['Write']
        });
        expect((await req('skills/demo', 'PUT', { description: 'desc', systemPrompt: 'prompt' })).data).toMatchObject({
            id: 'demo'
        });
        expect(registry.updateUserSkill).toHaveBeenLastCalledWith('demo', {
            name: '',
            description: 'desc',
            systemPrompt: 'prompt',
            displayName: undefined,
            triggers: undefined,
            allowedTools: undefined,
            disallowedTools: undefined
        });
        for (const body of [
            null,
            {},
            { description: 'd' },
            { description: 'd', systemPrompt: 'p' },
            { name: 'BAD', description: 'd', systemPrompt: 'p' }
        ])
            await req('skills', 'POST', body, 400);
        await req('skills/demo', 'PUT', {}, 400);
        for (const [url, method] of [
            ['skills', 'POST'],
            ['skills/demo', 'PUT']
        ]) {
            const response = await app.request(`/api/${url}`, {
                method,
                headers: { 'content-type': 'application/json' },
                body: '{'
            });
            expect(response.status).toBe(400);
            expect(((await response.json()) as { code: number }).code).toBe(400);
        }
        expect((await req('skills/demo', 'DELETE')).data).toEqual({ id: 'demo', deleted: true });
        expect(registry.removeUserSkill).toHaveBeenCalledWith('demo');
        expect((await req('skills/demo/toggle', 'PATCH')).data).toEqual({ id: 'demo', disabled: true });
        expect(registry.toggleSkill).toHaveBeenCalledWith('demo');
    });

    it('maps coded and uncoded domain errors consistently across all mutation handlers', async () => {
        for (const [error, status] of [
            [Object.assign(new Error('conflict'), { code: 'CONFLICT' }), 409],
            [Object.assign(new Error('readonly'), { code: 'FORBIDDEN' }), 403],
            [Object.assign(new Error('missing'), { code: 'NOT_FOUND' }), 404],
            [new Error('非法技能 id'), 400],
            [new Error('路径越界'), 400],
            [new Error('disk failure'), 500],
            ['string failure', 500]
        ] as const) {
            for (const [fn, url, method, body] of [
                [registry.createUserSkill, 'skills', 'POST', input],
                [registry.updateUserSkill, 'skills/demo', 'PUT', input],
                [registry.removeUserSkill, 'skills/demo', 'DELETE', undefined],
                [registry.toggleSkill, 'skills/demo/toggle', 'PATCH', undefined]
            ] as const) {
                fn.mockRejectedValueOnce(error);
                expect((await req(url, method, body, status)).message).toBe(
                    error instanceof Error ? error.message : error
                );
            }
        }
    });

    it('imports md/zip aliases with binary/text data, rejects broken multipart and unsupported files', async () => {
        expect((await upload('SKILL.md')).data).toEqual({ id: 'demo' });
        expect(registry.importSkill).toHaveBeenLastCalledWith('md', 'skill content');
        await upload('skill.zip', 'skills/import');
        expect(registry.importSkill).toHaveBeenLastCalledWith('zip', new TextEncoder().encode('skill content'));
        await upload('skill');
        await upload('', 'skills/upload', 400);
        await upload('bad.exe', 'skills/upload', 400);
        await upload(undefined, 'skills/upload', 400);
        const response = await app.request('/api/skills/upload', {
            method: 'POST',
            headers: { 'content-type': 'multipart/form-data' },
            body: 'broken'
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { message: string }).message).toContain('请求体解析失败');
        registry.importSkill.mockRejectedValueOnce(new Error('bad package'));
        await upload('skill.md', 'skills/upload', 400);
        registry.importSkill.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'CONFLICT' }));
        await upload('skill.md', 'skills/upload', 409);
    });

    it('exports binary ZIP with download headers and maps export failures', async () => {
        const response = await app.request('/api/skills/demo/export');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/zip');
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="demo.zip"');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([80, 75]));
        expect(registry.exportSkill).toHaveBeenCalledWith('demo');
        registry.exportSkill.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'NOT_FOUND' }));
        await req('skills/demo/export', 'GET', undefined, 404);
    });
});
