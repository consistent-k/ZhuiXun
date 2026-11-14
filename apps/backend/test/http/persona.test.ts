import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { setPersonaSettings } from '@/config/settings-store';
import { createPersonaRouter } from '@/http/routes/persona';

const app = new Hono();
app.route('/', createPersonaRouter());

async function request(url: string, method = 'GET', body?: unknown, status = 200) {
    const response = await app.request(`/api/${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    expect(response.status).toBe(status);
    const result = (await response.json()) as { code: number; message?: string; data: unknown };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result;
}

beforeEach(() => {
    setPersonaSettings({ defaultId: 'default', custom: [] });
});

describe('persona HTTP router', () => {
    it('lists built-ins, supports CRUD and avoids the default parameter collision', async () => {
        const initial = await request('personas');
        expect(initial.data).toMatchObject({ defaultId: 'default' });

        const created = await request('personas', 'POST', {
            name: '简洁快答',
            description: '快速阅读',
            instruction: '先给结论'
        });
        const config = created.data as {
            defaultId: string;
            items: Array<{ id: string; kind: string }>;
        };
        const id = config.items.find((item) => item.kind === 'custom')!.id;

        expect((await request('personas/default', 'PUT', { defaultId: id })).data).toMatchObject({ defaultId: id });
        expect(
            (
                await request(`personas/${encodeURIComponent(id)}`, 'PUT', {
                    name: '简洁快答 v2',
                    instruction: '先给处理建议'
                })
            ).data
        ).toMatchObject({
            items: expect.arrayContaining([expect.objectContaining({ id, name: '简洁快答 v2' })])
        });
        expect((await request(`personas/${encodeURIComponent(id)}`, 'DELETE')).data).toMatchObject({
            defaultId: 'default'
        });
    });

    it('maps validation, protected built-ins and missing ids to the expected status', async () => {
        await request('personas', 'POST', { name: '', instruction: 'x' }, 400);
        await request('personas', 'POST', { name: 'x' }, 400);
        await request('personas/default', 'PUT', { defaultId: 'missing' }, 404);
        await request('personas/default', 'PUT', {}, 400);
        await request('personas/evidence', 'PUT', { name: 'x' }, 400);
        await request('personas/evidence', 'DELETE', undefined, 400);
        await request('personas/missing', 'PUT', { name: 'x' }, 404);
        await request('personas/missing', 'DELETE', undefined, 404);
    });
});
