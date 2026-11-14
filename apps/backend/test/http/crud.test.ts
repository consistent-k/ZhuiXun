import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/http/middleware/error-handler';
import { createConversationsRouter } from '@/http/routes/conversations';
import { createMemoryRouter } from '@/http/routes/memory';
import { createPermissionRouter } from '@/http/routes/permission';
import { createProjectsRouter } from '@/http/routes/projects';
import type * as conversationsModule from '@/modules/conversations';
import type * as memoryModule from '@/modules/memory';
import type * as permissionModule from '@/modules/permission';
import type * as projectsModule from '@/modules/projects';

const fakes = vi.hoisted(() => ({
    conversations: {
        list: vi.fn(),
        readHistory: vi.fn(),
        exportAll: vi.fn(),
        importMany: vi.fn(),
        get: vi.fn(),
        exportOne: vi.fn(),
        upsert: vi.fn(),
        updateProjectId: vi.fn(),
        updatePersonaId: vi.fn(),
        updateTitle: vi.fn(),
        truncateFrom: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
        handleProjectRemoval: vi.fn()
    },
    checkpoint: { rewind: vi.fn() },
    projects: {
        list: vi.fn(),
        get: vi.fn(),
        upsert: vi.fn(),
        softDelete: vi.fn(),
        hardDelete: vi.fn(),
        restore: vi.fn()
    },
    permissions: { get: vi.fn(), remember: vi.fn(), deleteRule: vi.fn(), setAutoApproval: vi.fn(), setRules: vi.fn() },
    policy: { view: vi.fn(), evaluate: vi.fn() },
    memory: { list: vi.fn(), read: vi.fn(), write: vi.fn(), delete: vi.fn(), writeIndex: vi.fn() },
    readIndex: vi.fn(),
    dream: vi.fn(),
    validateDir: vi.fn(),
    root: vi.fn(),
    parent: vi.fn()
}));
vi.mock('@/modules/conversations', async (original) => ({
    ...(await original<typeof conversationsModule>()),
    getConversationStore: () => fakes.conversations,
    getCheckpointStore: () => fakes.checkpoint
}));
vi.mock('@/modules/projects', async (original) => ({
    ...(await original<typeof projectsModule>()),
    getProjectStore: () => fakes.projects,
    validateDir: fakes.validateDir
}));
vi.mock('@/modules/permission', async (original) => ({
    ...(await original<typeof permissionModule>()),
    getPermissionStore: () => fakes.permissions,
    getPolicyEngine: () => fakes.policy
}));
vi.mock('@/modules/memory', async (original) => ({
    ...(await original<typeof memoryModule>()),
    getMemoryStore: () => fakes.memory,
    readIndex: fakes.readIndex,
    runMemoryDream: fakes.dream,
    resolveMemoryRoot: fakes.root,
    projectsMemoryParent: fakes.parent
}));

const app = new Hono();
app.route('/', createConversationsRouter());
app.route('/', createProjectsRouter());
app.route('/', createPermissionRouter());
app.route('/', createMemoryRouter());
app.onError(errorHandler);
let dir: string;

async function req<T = unknown>(url: string, method = 'GET', body?: unknown, status = 200) {
    const response = await app.request(`/api/${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    const result = (await response.json()) as { code: number; data: T };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result.data;
}
async function badJson(url: string, method: string, status = 400) {
    const response = await app.request(`/api/${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: '{'
    });
    expect(response.status).toBe(status);
    expect(((await response.json()) as { code: number }).code).toBe(status === 200 ? 0 : status);
}

beforeEach(async () => {
    vi.clearAllMocks();
    dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'http-crud-'));
    fakes.conversations.list.mockResolvedValue([]);
    fakes.conversations.get.mockResolvedValue(null);
    fakes.conversations.upsert.mockImplementation(async (id, input) => ({ id, ...input }));
    fakes.conversations.updateProjectId.mockImplementation(async (id, projectId) => ({ id, projectId }));
    fakes.conversations.updatePersonaId.mockImplementation(async (id, personaId) => ({
        id,
        personaId: personaId ?? undefined
    }));
    fakes.conversations.updateTitle.mockImplementation(async (id, title) => ({ id, title }));
    fakes.conversations.truncateFrom.mockResolvedValue({ id: 'conv' });
    fakes.conversations.handleProjectRemoval.mockResolvedValue(['conv']);
    fakes.projects.list.mockResolvedValue([]);
    fakes.projects.get.mockResolvedValue({ id: 'proj', name: 'Project' });
    fakes.projects.upsert.mockImplementation(async (id, input) => ({ id, ...input }));
    fakes.projects.restore.mockResolvedValue({ id: 'proj' });
    fakes.validateDir.mockResolvedValue({ ok: true });
    fakes.memory.list.mockResolvedValue([]);
    fakes.memory.read.mockResolvedValue(null);
    fakes.memory.write.mockImplementation(async (input) => ({ record: input }));
    fakes.memory.delete.mockResolvedValue(true);
    fakes.readIndex.mockResolvedValue('# Index');
    fakes.root.mockImplementation((scope, id) => `${scope}/${id ?? ''}`);
    fakes.parent.mockReturnValue(path.join(dir, 'absent'));
    fakes.dream.mockResolvedValue(undefined);
});
afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('conversation HTTP boundary', () => {
    it('lists with correct three-way filters and static paths before :id', async () => {
        for (const [query, filter] of [
            ['', undefined],
            ['?projectId=', null],
            ['?projectId=__ungrouped__', null],
            ['?projectId=proj', 'proj']
        ] as const) {
            expect(await req(`conversations${query}`)).toEqual([]);
            expect(fakes.conversations.list).toHaveBeenLastCalledWith(filter);
        }
        fakes.conversations.readHistory.mockResolvedValue([{ event: 'save' }]);
        expect(await req('conversations/history')).toEqual([{ event: 'save' }]);
        fakes.conversations.exportAll.mockResolvedValue({ conversations: [] });
        expect(await req('conversations/export')).toEqual({ conversations: [] });
        fakes.conversations.importMany.mockResolvedValue({ imported: 1, remapped: {} });
        for (const body of [[{ id: 'import' }], { conversations: [{ id: 'import' }] }]) {
            expect(await req('conversations/import', 'POST', body)).toEqual({ imported: 1, remapped: {} });
            expect(fakes.conversations.importMany).toHaveBeenLastCalledWith([{ id: 'import' }]);
        }
        await req('conversations/import', 'POST', {}, 400);
        await badJson('conversations/import', 'POST');
    });

    it('upserts only valid message shapes and preserves metadata, parts, timestamps and project association', async () => {
        const body = {
            title: 'Title',
            createdAt: 123,
            projectId: 'proj',
            personaId: 'teaching',
            messages: [
                {
                    id: 'u1',
                    role: 'user',
                    content: 'hello',
                    timestamp: 124,
                    parts: [{ type: 'text', text: 'hello' }],
                    metadata: { usage: 5 }
                }
            ]
        };
        expect(await req('conversations/conv', 'PUT', body)).toEqual({ id: 'conv', ...body });
        expect(fakes.conversations.upsert).toHaveBeenLastCalledWith('conv', body);
        await req('conversations/conv', 'PUT', { title: '', messages: [] });
        expect(fakes.conversations.upsert).toHaveBeenLastCalledWith(
            'conv',
            expect.objectContaining({ createdAt: expect.any(Number), projectId: undefined })
        );
        for (const invalid of [
            null,
            1,
            {},
            { title: 1, messages: [] },
            { title: 'x', messages: {} },
            ...[null, {}, { id: 1 }, { id: 'x', role: 'system' }, { id: 'x', role: 'user', content: 1 }].map((m) => ({
                title: 'x',
                messages: [m]
            }))
        ]) {
            await req('conversations/conv', 'PUT', invalid, 400);
        }
        await req('conversations/bad%21', 'PUT', body, 400);
        await badJson('conversations/conv', 'PUT');
    });

    it('gets and exports missing/existing conversations and supports lightweight title/project patches', async () => {
        for (const route of ['conversations/conv', 'conversations/conv/export'])
            await req(route, 'GET', undefined, 404);
        fakes.conversations.get.mockResolvedValue({ id: 'conv', messages: [] });
        fakes.conversations.exportOne.mockResolvedValue({ id: 'conv', messages: [] });
        for (const route of ['conversations/conv', 'conversations/conv/export'])
            expect(await req(route)).toEqual({ id: 'conv', messages: [] });
        expect(await req('conversations/conv/project', 'PATCH', { projectId: 'proj' })).toEqual({
            id: 'conv',
            projectId: 'proj'
        });
        expect(await req('conversations/conv/project', 'PATCH', { projectId: '' })).toEqual({
            id: 'conv',
            projectId: null
        });
        await badJson('conversations/conv/project', 'PATCH', 200);
        expect(await req('conversations/conv/title', 'PATCH', { title: ' New title ' })).toEqual({
            id: 'conv',
            title: 'New title'
        });
        expect(fakes.conversations.updateTitle).toHaveBeenLastCalledWith('conv', 'New title', { auto: true });
        await req('conversations/conv/title', 'PATCH', { title: 1 }, 400);
        await badJson('conversations/conv/title', 'PATCH');
        expect(await req('conversations/conv/persona', 'PATCH', { personaId: 'default' })).toEqual({
            id: 'conv',
            personaId: 'default'
        });
        expect(await req('conversations/conv/persona', 'PATCH', { personaId: null })).toEqual({ id: 'conv' });
        expect(fakes.conversations.updatePersonaId).toHaveBeenLastCalledWith('conv', null);
        await req('conversations/conv/persona', 'PATCH', { personaId: 'missing' }, 400);
        await req('conversations/conv/persona', 'PATCH', {}, 400);
        await badJson('conversations/conv/persona', 'PATCH');
        fakes.conversations.updateProjectId.mockResolvedValueOnce(null);
        fakes.conversations.updatePersonaId.mockResolvedValueOnce(null);
        fakes.conversations.updateTitle.mockResolvedValueOnce(null);
        await req('conversations/conv/project', 'PATCH', {}, 404);
        await req('conversations/conv/persona', 'PATCH', { personaId: null }, 404);
        await req('conversations/conv/title', 'PATCH', { title: 'x' }, 404);
        for (const field of ['project', 'persona', 'title'])
            await req(`conversations/bad%21/${field}`, 'PATCH', {}, 400);
    });

    it('rewinds files before truncating messages; handles missing targets and delete/clear envelopes', async () => {
        fakes.checkpoint.rewind.mockResolvedValue({ restored: ['a'], deleted: [], skipped: [] });
        expect(await req('conversations/conv/rewind', 'POST', { toMessageId: 'u1' })).toMatchObject({
            meta: { id: 'conv' },
            files: { restored: ['a'] }
        });
        expect(fakes.checkpoint.rewind.mock.invocationCallOrder.at(-1)).toBeLessThan(
            fakes.conversations.truncateFrom.mock.invocationCallOrder.at(-1)!
        );
        fakes.conversations.truncateFrom.mockResolvedValueOnce(null);
        await req('conversations/conv/rewind', 'POST', { toMessageId: 'u1' }, 404);
        await req('conversations/bad%21/rewind', 'POST', {}, 400);
        await req('conversations/conv/rewind', 'POST', {}, 400);
        await badJson('conversations/conv/rewind', 'POST');
        expect(await req('conversations/conv', 'DELETE')).toEqual({ id: 'conv' });
        expect(fakes.conversations.delete).toHaveBeenCalledWith('conv');
        fakes.conversations.clear.mockResolvedValueOnce(4);
        expect(await req('conversations', 'DELETE')).toEqual({ cleared: 4 });
    });
});

describe('project HTTP boundary', () => {
    it('lists, creates, normalizes every optional field and validates directories', async () => {
        await req('projects');
        expect(fakes.projects.list).toHaveBeenLastCalledWith({ includeDeleted: false });
        await req('projects?includeDeleted=1');
        expect(fakes.projects.list).toHaveBeenLastCalledWith({ includeDeleted: true });
        const data = await req('projects', 'POST', {
            name: ' Project ',
            icon: 'i',
            color: 'red',
            archived: true,
            instructions: 'docs',
            defaultSkillId: 'skill',
            skillPreset: ['a'],
            roots: [' /one ', '', { path: ' /two ', primary: true }, { path: '' }, null, 1],
            trusted: true,
            createdAt: 10
        });
        expect(data).toMatchObject({
            id: expect.any(String),
            name: 'Project',
            roots: [{ path: '/one' }, { path: '/two', primary: true }],
            skillPreset: ['a'],
            trusted: true,
            createdAt: 10,
            icon: 'i',
            color: 'red',
            archived: true,
            instructions: 'docs',
            defaultSkillId: 'skill'
        });
        expect(fakes.validateDir).toHaveBeenCalledWith('/two');
        await req('projects', 'POST', { name: 'P' });
        for (const body of [null, 1, {}, { name: ' ' }, { name: 123 }]) await req('projects', 'POST', body, 400);
        await badJson('projects', 'POST');
        fakes.validateDir.mockResolvedValueOnce({ ok: false, reason: 'not found' });
        await req('projects', 'POST', { name: 'P', roots: ['/bad'] }, 400);
    });

    it('updates existing projects, trust, soft/hard deletion, restoration and missing IDs', async () => {
        expect(await req('projects/proj')).toEqual({ id: 'proj', name: 'Project' });
        await req('projects/proj', 'PUT', { name: 'Changed', roots: [] });
        expect(fakes.projects.upsert).toHaveBeenLastCalledWith('proj', { name: 'Changed', roots: [] });
        expect(await req('projects/proj/trust', 'PUT', { trusted: true })).toEqual({
            id: 'proj',
            name: 'Project',
            trusted: true
        });
        expect(await req('projects/proj', 'DELETE')).toEqual({ id: 'proj', mode: 'soft', movedSessions: ['conv'] });
        expect(fakes.projects.softDelete).toHaveBeenCalledWith('proj');
        for (const cascade of [false, true]) {
            expect(await req(`projects/proj?hard=1${cascade ? '&cascade=1' : ''}`, 'DELETE')).toEqual({
                id: 'proj',
                mode: 'hard',
                cascade,
                movedSessions: ['conv']
            });
            expect(fakes.conversations.handleProjectRemoval).toHaveBeenLastCalledWith('proj', cascade);
        }
        expect(await req('projects/proj/restore', 'POST')).toEqual({ id: 'proj' });
        fakes.projects.restore.mockResolvedValueOnce(null);
        await req('projects/proj/restore', 'POST', undefined, 404);
        fakes.projects.get.mockResolvedValue(null);
        await req('projects/missing', 'GET', undefined, 404);
        await req('projects/missing', 'PUT', { name: 'P' }, 404);
        await req('projects/missing/trust', 'PUT', { trusted: true }, 404);
        await req('projects/proj', 'PUT', {}, 400);
        await badJson('projects/proj', 'PUT');
        await req('projects/proj/trust', 'PUT', {}, 400);
        await badJson('projects/proj/trust', 'PUT');
        fakes.validateDir.mockResolvedValueOnce({ ok: false, reason: 'denied' });
        await req('projects/proj', 'PUT', { name: 'P', roots: ['/bad'] }, 400);
        for (const [url, method] of [
            ['projects/bad%21', 'PUT'],
            ['projects/bad%21/trust', 'PUT'],
            ['projects/bad%21', 'DELETE'],
            ['projects/bad%21/restore', 'POST']
        ])
            await req(url!, method!, {}, 400);
    });

    it('path validation is a business result and directory browsing hides files/hidden entries, follows only directory symlinks', async () => {
        expect(await req('projects/validate-path', 'POST', {})).toEqual({ ok: false, reason: '请填写路径' });
        await badJson('projects/validate-path', 'POST', 200);
        expect(await req('projects/validate-path', 'POST', { path: ' /valid ' })).toEqual({ ok: true });
        expect(fakes.validateDir).toHaveBeenLastCalledWith('/valid');
        await fs.mkdir(path.join(dir, 'z-dir'), { recursive: true });
        await fs.mkdir(path.join(dir, '.hidden'), { recursive: true });
        await fs.writeFile(path.join(dir, 'file.txt'), 'x');
        await fs.symlink(path.join(dir, 'z-dir'), path.join(dir, 'a-link')).catch(() => undefined);
        await fs.symlink(path.join(dir, 'missing'), path.join(dir, 'broken-link')).catch(() => undefined);
        const browse = await req<{ entries: { name: string }[] }>(
            `projects/browse-dir?path=${encodeURIComponent(dir)}`
        );
        expect(browse.entries.map((e: { name: string }) => e.name)).toEqual(['a-link', 'z-dir']);
        expect(browse).toMatchObject({ path: dir, parent: path.dirname(dir), home: os.homedir() });
        await req('projects/browse-dir?path=relative', 'GET', undefined, 400);
        await req(`projects/browse-dir?path=${encodeURIComponent(path.join(dir, 'missing'))}`, 'GET', undefined, 400);
        expect(await req('projects/browse-dir')).toMatchObject({ path: os.homedir() });
        expect(await req('projects/browse-dir?path=/')).toMatchObject({ parent: null });
    });
});

describe('permission HTTP boundary', () => {
    it('reads, remembers both tool shapes, deletes and toggles approval without exposing a full class', async () => {
        fakes.permissions.get.mockResolvedValue({ autoApproval: false, rules: [] });
        expect(await req('permissions')).toEqual({ autoApproval: false, rules: [] });
        fakes.permissions.remember.mockResolvedValue({ id: 'rule' });
        expect(await req('permissions', 'POST', { scope: 'permanent', command: 'pwd' })).toEqual({ id: 'rule' });
        expect(fakes.permissions.remember).toHaveBeenLastCalledWith({
            tool: 'Bash',
            command: 'pwd',
            filePath: undefined,
            scope: 'permanent',
            sessionId: undefined
        });
        await req('permissions', 'POST', { tool: 'Write', scope: 'session', filePath: '/tmp/file', sessionId: 'conv' });
        expect(fakes.permissions.remember).toHaveBeenLastCalledWith({
            tool: 'Write',
            command: undefined,
            filePath: '/tmp/file',
            scope: 'session',
            sessionId: 'conv'
        });
        expect(await req('permissions/rule', 'DELETE')).toEqual({ id: 'rule' });
        expect(fakes.permissions.deleteRule).toHaveBeenCalledWith('rule');
        fakes.permissions.setAutoApproval.mockResolvedValue({ enabled: true });
        expect(await req('permissions/auto-approval', 'PUT', { enabled: true })).toEqual({ enabled: true });
        expect(fakes.permissions.setAutoApproval).toHaveBeenCalledWith(true);
        for (const body of [
            null,
            {},
            { scope: 'invalid' },
            { scope: 'permanent' },
            { scope: 'session', tool: 'Write', command: 'wrong' }
        ])
            await req('permissions', 'POST', body, 400);
        await badJson('permissions', 'POST');
        await req('permissions/auto-approval', 'PUT', { enabled: 1 }, 400);
        await badJson('permissions/auto-approval', 'PUT');
    });

    it('reads, validates and replaces declarative rules, and evaluates without side effects', async () => {
        const view = { baselineSource: 'builtin', user: { deny: [], ask: [], allow: [] } };
        fakes.policy.view.mockResolvedValue(view);
        expect(await req('permissions/rules')).toEqual(view);
        expect(
            await req('permissions/rules', 'PUT', {
                deny: [' Read(**/x) ', 'Read(**/x)'],
                ask: [],
                allow: ['Bash(npm:*)']
            })
        ).toEqual(view);
        expect(fakes.permissions.setRules).toHaveBeenCalledWith({
            deny: ['Read(**/x)'],
            ask: [],
            allow: ['Bash(npm:*)']
        });
        await req('permissions/rules', 'PUT', { deny: ['Bash('], ask: [], allow: [] }, 400);
        await req('permissions/rules', 'PUT', { deny: [] }, 400);
        await badJson('permissions/rules', 'PUT');
        expect(fakes.permissions.setRules).toHaveBeenCalledTimes(1);

        expect(await req('permissions/rules/evaluate', 'POST', { rule: 'Bash(' })).toEqual({
            valid: false,
            error: expect.stringContaining('格式不合法')
        });
        expect(await req('permissions/rules/evaluate', 'POST', { rule: 'Read' })).toEqual({ valid: true });
        fakes.policy.evaluate.mockResolvedValue({ decision: 'deny', rule: 'MCP(x_*)' });
        expect(
            await req('permissions/rules/evaluate', 'POST', { toolName: 'x_y', input: { a: 1 }, cwd: '/p', mcp: true })
        ).toEqual({ valid: true, decision: { decision: 'deny', rule: 'MCP(x_*)' } });
        const [toolName, input, ctx] = fakes.policy.evaluate.mock.calls[0];
        expect([toolName, input, ctx.cwd, ctx.isMcpTool('x_y')]).toEqual(['x_y', { a: 1 }, '/p', true]);
        await req('permissions/rules/evaluate', 'POST', { toolName: 'Read' });
        expect(fakes.policy.evaluate.mock.calls[1][1]).toEqual({});
        expect(fakes.policy.evaluate.mock.calls[1][2].isMcpTool('Read')).toBe(false);
        expect(fakes.policy.evaluate.mock.calls[1][2].cwd).toContain('zhuixun-workspace');
        await req('permissions/rules/evaluate', 'POST', { toolName: '' }, 400);
        await badJson('permissions/rules/evaluate', 'POST');
    });
});

describe('memory HTTP boundary', () => {
    it('normalizes scope and exposes index/settings/items, patches flags/index independently', async () => {
        expect(await req('memory?scope=invalid')).toMatchObject({ scope: 'global', index: '# Index', items: [] });
        expect(await req('memory?scope=project')).toMatchObject({ scope: 'global' });
        expect(await req('memory?scope=project&projectId=proj')).toMatchObject({ scope: 'project', projectId: 'proj' });
        expect(fakes.root).toHaveBeenLastCalledWith('project', 'proj');
        expect(
            await req('memory', 'PATCH', {
                enabled: false,
                autoExtract: false,
                autoDream: true,
                index: '# Updated',
                scope: 'project',
                projectId: 'proj'
            })
        ).toMatchObject({ enabled: false, autoExtract: false, autoDream: true, scope: 'project' });
        expect(fakes.memory.writeIndex).toHaveBeenCalledWith('# Updated');
        await req('memory', 'PATCH', {});
        await req('memory', 'PATCH', null, 400);
        await req('memory', 'PATCH', 1, 400);
        await badJson('memory', 'PATCH');
    });

    it('reads/writes/deletes records, defaults optional text and returns domain validation failures', async () => {
        await req('memory/item', 'GET', undefined, 404);
        expect(fakes.memory.read).toHaveBeenCalledWith('');
        fakes.memory.read.mockResolvedValueOnce({ name: 'note', content: 'body' });
        expect(await req('memory/item?name=note')).toEqual({ name: 'note', content: 'body' });
        expect(
            await req('memory/item', 'PUT', { name: 'note', type: 'user', description: 'desc', content: 'body' })
        ).toEqual({ name: 'note', type: 'user', description: 'desc', content: 'body' });
        expect(await req('memory/item', 'PUT', { name: 'note', type: 'user' })).toMatchObject({
            description: '',
            content: ''
        });
        await req('memory/item', 'PUT', { name: 'note', type: 'invalid' }, 400);
        await badJson('memory/item', 'PUT');
        fakes.memory.write.mockRejectedValueOnce(new Error('非法名称')).mockRejectedValueOnce('failure');
        await req('memory/item', 'PUT', { name: 'bad', type: 'user' }, 400);
        await req('memory/item', 'PUT', { name: 'bad', type: 'user' }, 400);
        expect(await req('memory/item?name=note', 'DELETE')).toEqual({ ok: true });
        expect(fakes.memory.delete).toHaveBeenLastCalledWith('note');
        await req('memory/item', 'DELETE');
        expect(fakes.memory.delete).toHaveBeenLastCalledWith('');
    });

    it('lists only nonempty project memory, tolerates deleted projects and fires dream with explicit force', async () => {
        expect(await req('memory/projects')).toEqual([]);
        const parent = path.join(dir, 'memory-projects');
        await fs.mkdir(parent, { recursive: true });
        for (const p of ['one', 'two', 'three']) await fs.mkdir(path.join(parent, p), { recursive: true });
        fakes.parent.mockReturnValueOnce(parent);
        fakes.memory.list
            .mockResolvedValueOnce([{ updatedAt: '2026' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ updatedAt: '2025' }]);
        fakes.projects.get.mockResolvedValueOnce({ name: 'Known' }).mockRejectedValueOnce(new Error('gone'));
        const list = await req<{ label: string; count: number }[]>('memory/projects');
        expect(list).toHaveLength(2);
        expect(list.map((item: { label: string }) => item.label)).toEqual(['Known', expect.any(String)]);
        expect(list.map((item: { count: number }) => item.count)).toEqual([1, 1]);
        expect(await req('memory/dream', 'POST', { projectId: 'proj' })).toEqual({ started: true });
        expect(fakes.dream).toHaveBeenLastCalledWith({ projectId: 'proj', force: true });
        await badJson('memory/dream', 'POST', 200);
        expect(fakes.dream).toHaveBeenLastCalledWith({ projectId: undefined, force: true });
    });
});

describe('dependency failures cross the real router and global error handler', () => {
    it.each(['conversations', 'projects', 'permissions', 'memory'])(
        'returns an error envelope for %s',
        async (domain) => {
            const dependency =
                domain === 'conversations'
                    ? fakes.conversations.list
                    : domain === 'projects'
                      ? fakes.projects.list
                      : domain === 'permissions'
                        ? fakes.permissions.get
                        : fakes.memory.list;
            dependency.mockRejectedValueOnce(new Error('store unavailable'));
            const response = await app.request(`/api/${domain}`);
            expect(response.status).toBe(500);
            expect(await response.json()).toEqual({ code: 500, message: 'store unavailable' });
        }
    );
});
