import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { fail, notReady, ok } from '@/http/respond';

describe('HTTP response envelope', () => {
    it('returns success, failure and not-ready envelopes', async () => {
        const app = new Hono();
        app.get('/ok', (c) => ok(c, { value: 1 }));
        app.get('/fail', (c) => fail(c, 409, 'conflict'));
        app.get('/not-ready', (c) => notReady(c));
        app.get('/custom-status', (c) => fail(c, 1001, 'business conflict', 409));
        app.get('/custom-ready', (c) => notReady(c, 'registry loading'));

        const okResponse = await app.request('/ok');
        expect(okResponse.status).toBe(200);
        await expect(okResponse.json()).resolves.toEqual({ code: 0, data: { value: 1 } });

        const failResponse = await app.request('/fail');
        expect(failResponse.status).toBe(409);
        await expect(failResponse.json()).resolves.toEqual({ code: 409, message: 'conflict' });

        const notReadyResponse = await app.request('/not-ready');
        expect(notReadyResponse.status).toBe(503);
        await expect(notReadyResponse.json()).resolves.toEqual({ code: 503, message: '服务尚未就绪' });

        const customStatus = await app.request('/custom-status');
        expect(customStatus.status).toBe(409);
        await expect(customStatus.json()).resolves.toEqual({ code: 1001, message: 'business conflict' });
        const customReady = await app.request('/custom-ready');
        expect(customReady.status).toBe(503);
        await expect(customReady.json()).resolves.toEqual({ code: 503, message: 'registry loading' });
    });
});
