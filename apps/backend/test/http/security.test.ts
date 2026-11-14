import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '@/bootstrap/app';
import { apiGuard, corsOriginResolver } from '@/http/middleware/auth';
import { errorHandler, errorPayload } from '@/http/middleware/error-handler';
import { httpLogger } from '@/http/middleware/request-logger';
import { createHealthRouter } from '@/http/routes/health';
import type { RuntimeStatus } from '@/platform/runtime-status';

const original = {
    token: process.env.API_AUTH_TOKEN,
    origins: process.env.ALLOWED_ORIGINS,
    nodeEnv: process.env.NODE_ENV
};
afterEach(() => {
    for (const [key, value] of [
        ['API_AUTH_TOKEN', original.token],
        ['ALLOWED_ORIGINS', original.origins],
        ['NODE_ENV', original.nodeEnv]
    ]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
    }
    vi.restoreAllMocks();
});
function guarded() {
    const app = new Hono();
    app.use('*', httpLogger);
    app.use('*', cors({ origin: corsOriginResolver, credentials: true }));
    app.use('/api/*', apiGuard);
    app.get('/api/probe', (c) => c.json({ code: 0, data: 'ok' }));
    app.get('/api/mcp/oauth/callback', (c) => c.text('callback'));
    app.get('/api/chat/files/:sid/:id', (c) => c.text('attachment'));
    app.get('/api/failure', () => {
        throw new Error('private-test-key');
    });
    app.onError(errorHandler);
    return app;
}

describe('HTTP auth/CORS/request scope and error exposure', () => {
    it('enforces Origin server-side, supports defaults/additional origins and returns CORS headers only for allowed origins', async () => {
        delete process.env.API_AUTH_TOKEN;
        process.env.ALLOWED_ORIGINS = 'https://extra.test, http://localhost:8080';
        const app = guarded();
        for (const origin of ['app://local', 'http://localhost:8080', 'http://127.0.0.1:8080', 'https://extra.test']) {
            const response = await app.request('/api/probe', { headers: { origin } });
            expect(response.status).toBe(200);
            expect(response.headers.get('access-control-allow-origin')).toBe(origin);
            expect(response.headers.get('access-control-allow-credentials')).toBe('true');
            expect(await response.json()).toEqual({ code: 0, data: 'ok' });
        }
        const blocked = await app.request('/api/probe', { headers: { origin: 'https://evil.test' } });
        expect(blocked.status).toBe(403);
        expect(await blocked.json()).toEqual({ code: 403, message: '来源不被允许' });
        expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
        expect(blocked.headers.get('x-request-id')).toBeTruthy();
        expect((await app.request('/api/probe')).status).toBe(200);
        const preflight = await app.request('/api/probe', {
            method: 'OPTIONS',
            headers: {
                origin: 'app://local',
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'x-zhuixun-token'
            }
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-headers')).toBe('x-zhuixun-token');
    });

    it('requires exact token except OAuth and attachment paths, still checks their Origin', async () => {
        process.env.API_AUTH_TOKEN = 'test-only-shared-token';
        const app = guarded();
        for (const headers of [{}, { 'x-zhuixun-token': 'wrong' }]) {
            const response = await app.request('/api/probe', { headers });
            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ code: 401, message: '未授权' });
        }
        expect(
            (await app.request('/api/probe', { headers: { 'x-zhuixun-token': 'test-only-shared-token' } })).status
        ).toBe(200);
        for (const route of ['/api/mcp/oauth/callback', '/api/chat/files/conv/file']) {
            expect((await app.request(route)).status).toBe(200);
            expect((await app.request(route, { headers: { origin: 'https://evil.test' } })).status).toBe(403);
        }
        const composed = createApp(() => undefined);
        expect((await composed.request('/health')).status).toBe(503);
        const blocked = await composed.request('/api/settings/model');
        expect(blocked.status).toBe(401);
        expect(await blocked.json()).toEqual({ code: 401, message: '未授权' });
    });

    it('uses one request-id for errors/headers, isolates concurrent scopes and hides internals in production', async () => {
        delete process.env.API_AUTH_TOKEN;
        const app = guarded();
        process.env.NODE_ENV = 'development';
        const dev = await app.request('/api/failure', { headers: { 'x-request-id': 'dev-id' } });
        expect(dev.status).toBe(500);
        expect(dev.headers.get('x-request-id')).toBe('dev-id');
        expect(await dev.json()).toEqual({ code: 500, message: 'private-test-key' });
        process.env.NODE_ENV = 'production';
        const results = await Promise.all(
            ['first', 'second'].map(async (id) => {
                const response = await app.request('/api/failure', { headers: { 'x-request-id': id } });
                expect(response.headers.get('x-request-id')).toBe(id);
                expect(await response.json()).toEqual({ code: 500, message: `服务器内部错误（requestId: ${id}）` });
            })
        );
        expect(results).toHaveLength(2);
        const generated = await app.request('/api/failure');
        const id = generated.headers.get('x-request-id');
        expect(id).toMatch(/^[\da-f-]{36}$/);
        expect(await generated.json()).toEqual({ code: 500, message: `服务器内部错误（requestId: ${id}）` });
        process.env.NODE_ENV = 'test';
        expect(errorPayload('non-error', 502)).toEqual({ code: 502, message: 'non-error' });
    });
});

describe('health raw monitoring contract', () => {
    it('reports unavailable defaults, initialization error and ready/degraded states without an API envelope', async () => {
        let runtime: RuntimeStatus | undefined;
        const router = createHealthRouter(() => runtime);
        let response = await router.request('/health');
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
            status: 'unavailable',
            ready: false,
            mcp: 'unknown',
            skills: 0,
            dangerSkipPermissions: false,
            timestamp: expect.any(Number)
        });
        runtime = {
            ready: false,
            mcp: 'failed',
            skills: 2,
            dangerSkipPermissions: true,
            mcpError: 'initialization failure',
            startedAt: '2026-01-01T00:00:00Z'
        };
        response = await router.request('/health');
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
            mcp: 'failed',
            mcpError: 'initialization failure',
            skills: 2,
            dangerSkipPermissions: true
        });
        for (const mcp of ['ok', 'degraded', 'failed'] as const) {
            runtime = { ready: true, mcp, skills: 2, dangerSkipPermissions: true, startedAt: '2026-01-01T00:00:00Z' };
            response = await router.request('/health');
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                status: mcp === 'ok' ? 'ok' : 'degraded',
                ready: true,
                mcp,
                startedAt: '2026-01-01T00:00:00Z'
            });
        }
    });

    it('appends security posture extras when ready and ignores extras failures', async () => {
        const runtime: RuntimeStatus = {
            ready: true,
            mcp: 'ok',
            skills: 0,
            dangerSkipPermissions: false,
            startedAt: '2026-01-01T00:00:00Z'
        };
        const withExtras = createHealthRouter(
            () => runtime,
            async () => ({ permissionBaseline: 'external' })
        );
        expect(await (await withExtras.request('/health')).json()).toMatchObject({ permissionBaseline: 'external' });
        const failing = createHealthRouter(
            () => runtime,
            () => Promise.reject(new Error('io'))
        );
        const response = await failing.request('/health');
        expect(response.status).toBe(200);
        expect(await response.json()).not.toHaveProperty('permissionBaseline');
    });
});
