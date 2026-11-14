import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { errorHandler, notFoundHandler } from '@/http/middleware/error-handler';

describe('HTTP error handlers', () => {
    it('returns a stable not found envelope', async () => {
        const app = new Hono();
        app.notFound(notFoundHandler);
        const response = await app.request('/missing');
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ code: 404, message: 'Not found' });
    });

    it('exposes the error message outside production', async () => {
        const app = new Hono();
        app.onError(errorHandler);
        app.get('/', () => {
            throw new Error('visible failure');
        });
        const response = await app.request('/');
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ code: 500, message: 'visible failure' });
    });
});
