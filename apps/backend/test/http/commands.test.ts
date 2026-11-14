import fs from 'node:fs/promises';

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import { errorHandler } from '@/http/middleware/error-handler';
import { createCommandsRouter } from '@/http/routes/commands';
import { createConversationsRouter } from '@/http/routes/conversations';
import type * as ChatModule from '@/modules/chat';
import { CommandError, getCommandStore } from '@/modules/commands';

const f = vi.hoisted(() => ({ compact: vi.fn() }));
vi.mock('@/modules/chat', async (original) => ({
    ...(await original<typeof ChatModule>()),
    compactConversation: f.compact
}));

const app = new Hono();
app.route('/', createCommandsRouter());
app.route('/', createConversationsRouter());
app.onError(errorHandler);

async function call(url: string, method = 'GET', body?: unknown) {
    const response = await app.request(`/api/${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    return {
        status: response.status,
        json: (await response.json()) as {
            code: number;
            data?: Record<string, unknown> & { user?: unknown; body?: unknown };
            message?: string;
        }
    };
}

beforeEach(async () => {
    vi.clearAllMocks();
    await fs.rm(paths.commandsDir(), { recursive: true, force: true });
});

describe('commands HTTP boundary', () => {
    it('lists builtin + user commands, saves, reads, expands and deletes', async () => {
        expect((await call('commands')).json.data).toMatchObject({
            builtin: expect.arrayContaining([expect.objectContaining({ name: 'compact' })]),
            user: []
        });
        const saved = await call('commands/review', 'PUT', { description: '审查', body: '审查 $1' });
        expect(saved.json.data).toEqual({ name: 'review', description: '审查', body: '审查 $1' });
        expect((await call('commands')).json.data!.user).toEqual([
            { name: 'review', description: '审查', argumentHint: undefined }
        ]);
        expect((await call('commands/review')).json.data!.body).toBe('审查 $1');
        expect((await call('commands/missing')).status).toBe(404);
        expect((await call('commands/expand', 'POST', { text: '/review a.ts b' })).json.data).toEqual({
            matched: true,
            name: 'review',
            args: 'a.ts b',
            expanded: '审查 a.ts'
        });
        expect((await call('commands/expand', 'POST', { text: '/nope' })).json.data).toEqual({ matched: false });
        expect((await call('commands/expand', 'POST', '{')).status).toBe(400);
        expect((await call('commands/review', 'DELETE')).json.data).toEqual({ name: 'review' });
        expect((await call('commands/review')).status).toBe(404);
    });

    it('validates names, builtin conflicts and bodies, and surfaces unexpected errors as 500', async () => {
        expect(await call('commands/compact', 'PUT', { body: 'x' })).toMatchObject({
            status: 400,
            json: { message: expect.stringContaining('内置命令') }
        });
        expect((await call('commands/Bad', 'PUT', { body: 'x' })).status).toBe(400);
        expect((await call('commands/ok', 'PUT', { body: '' })).status).toBe(400);
        expect((await call('commands/ok', 'PUT', '{')).status).toBe(400);
        expect((await call('commands/Bad', 'DELETE')).status).toBe(400);
        const save = vi.spyOn(getCommandStore(), 'save').mockRejectedValueOnce(new Error('disk'));
        expect((await call('commands/ok', 'PUT', { body: 'x' })).status).toBe(500);
        save.mockRestore();
        const del = vi.spyOn(getCommandStore(), 'delete').mockRejectedValueOnce(new Error('disk'));
        expect((await call('commands/ok', 'DELETE')).status).toBe(500);
        del.mockRestore();
        expect(new CommandError(404, 'x').status).toBe(404);
    });
});

describe('POST /api/conversations/:id/compact', () => {
    it('forwards instructions, maps CompactError statuses and validates the body', async () => {
        f.compact.mockResolvedValue({ changed: false });
        expect((await call('conversations/c1/compact', 'POST', { instructions: '保留' })).json).toEqual({
            code: 0,
            data: { changed: false }
        });
        expect(f.compact).toHaveBeenCalledWith('c1', '保留');
        await call('conversations/c1/compact', 'POST');
        expect(f.compact).toHaveBeenLastCalledWith('c1', undefined);
        const { CompactError } = await vi.importActual<typeof ChatModule>('@/modules/chat');
        f.compact.mockRejectedValueOnce(new CompactError(409, '会话正在生成回复，请稍后再压缩'));
        expect(await call('conversations/c1/compact', 'POST', {})).toEqual({
            status: 409,
            json: { code: 409, message: '会话正在生成回复，请稍后再压缩' }
        });
        f.compact.mockRejectedValueOnce(new Error('boom'));
        expect((await call('conversations/c1/compact', 'POST', {})).status).toBe(500);
        expect((await call('conversations/c1/compact', 'POST', { instructions: 1 })).status).toBe(400);
        expect((await call('conversations/c1/compact', 'POST', { instructions: 'x'.repeat(2001) })).status).toBe(400);
    });
});
