import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as settingsStore from '@/config/settings-store';
import settings from '@/http/routes/settings';
import { WebAccessError } from '@/platform/web';
import type * as webModule from '@/platform/web';

const external = vi.hoisted(() => ({ model: vi.fn(), generate: vi.fn(), fetchPage: vi.fn() }));
vi.mock('@/agent/model/provider', () => ({ createModel: external.model }));
vi.mock('ai', () => ({ generateText: external.generate }));
vi.mock('@/platform/web', async (original) => ({
    ...(await original<typeof webModule>()),
    fetchReadablePage: external.fetchPage
}));

async function request(path: string, method = 'GET', body?: unknown, status = 200) {
    const response = await settings.request(`/api/settings/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    const result = (await response.json()) as { code: number; message?: string; data: unknown };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result;
}
const provider = {
    name: 'demo',
    kind: 'openai' as const,
    baseURL: 'https://example.test',
    apiKey: 'test-only-secret',
    models: ['m']
};

beforeEach(() => {
    vi.restoreAllMocks();
    external.model.mockReset().mockReturnValue({ modelId: 'fake' });
    external.generate.mockReset().mockResolvedValue({ text: 'pong' });
    external.fetchPage.mockReset().mockResolvedValue({ title: 'Page', content: 'body', truncated: false });
    for (const p of settingsStore.listProviders()) settingsStore.deleteProvider(p.name);
    settingsStore.importSettings({ model: { providers: [], activeModel: undefined }, app: {}, env: {} });
});

describe('settings real HTTP router', () => {
    it('provider CRUD masks keys, keeps saved keys on edits, validates active references and maps conflicts', async () => {
        const created = await request('providers', 'POST', provider);
        expect(created.data).toMatchObject({ name: 'demo', configured: true });
        expect(JSON.stringify(created)).not.toContain(provider.apiKey);
        await request('providers', 'POST', provider, 409);
        await request('providers/nope', 'PUT', {}, 404);
        await request('model/active', 'PUT', { activeModel: 'unknown/m' }, 400);
        expect((await request('model/active', 'PUT', { activeModel: 'demo/m' })).data).toMatchObject({
            activeModel: 'demo/m'
        });
        await request('providers/demo', 'PUT', { name: 'renamed', modelMeta: { m: { contextWindow: 1234 } } });
        const model = await request('model');
        expect(model.data).toMatchObject({ activeModel: 'renamed/m' });
        expect(model.data).toMatchObject({ providers: [{ name: 'renamed', configured: true }] });
        expect(JSON.stringify(model)).not.toContain('test-only-secret');
        const exported = await request('export');
        expect(JSON.stringify(exported)).not.toContain('test-only-secret');
        expect((await request('providers/renamed', 'DELETE')).data).toMatchObject({ deleted: true });
        expect((await request('providers/renamed', 'DELETE')).data).toMatchObject({ deleted: false });
        expect((await request('providers', 'POST', { ...provider, apiKey: undefined })).data).toMatchObject({
            configured: false
        });
    });

    it.each([
        ['providers', 'POST', null],
        ['providers', 'POST', { ...provider, name: 'bad/name' }],
        ['providers/demo', 'PUT', { modelMeta: { m: { contextWindow: 0 } } }],
        ['model/active', 'PUT', {}],
        ['providers/demo/test', 'POST', { model: 1 }],
        ['app', 'PUT', { autoCompactThreshold: 49 }],
        ['import', 'POST', { env: [] }],
        ['env', 'POST', { key: 'bad', value: 'x' }],
        ['web', 'PUT', { allowedHosts: ['https://bad/path'] }],
        ['web/test', 'POST', { url: '' }]
    ])('rejects bad request shape for %s', async (path, method, body) => {
        const result = await request(path as string, method as string, body, 400);
        expect(result.message).toContain('请求参数不合法');
    });

    it.each([
        ['providers', 'POST'],
        ['providers/demo', 'PUT'],
        ['model/active', 'PUT'],
        ['app', 'PUT'],
        ['import', 'POST'],
        ['env', 'POST'],
        ['web', 'PUT'],
        ['web/test', 'POST']
    ])('rejects malformed JSON for %s', async (path, method) => {
        const response = await settings.request(`/api/settings/${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: '{'
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { code: number }).code).toBe(400);
    });

    it('connectivity tests use only backend keys and return business failures in a successful envelope', async () => {
        await request('providers/missing/test', 'POST', {}, 404);
        settingsStore.addProvider({ ...provider, apiKey: '' });
        expect((await request('providers/demo/test', 'POST', {})).data).toEqual({ ok: false, error: '未配置 API Key' });
        settingsStore.updateProvider('demo', { apiKey: provider.apiKey, models: [] });
        expect((await request('providers/demo/test', 'POST', {})).data).toMatchObject({ error: '未配置模型名' });
        settingsStore.updateProvider('demo', { models: ['m'] });
        expect((await request('providers/demo/test', 'POST', {})).data).toMatchObject({ ok: true });
        expect(external.model).toHaveBeenLastCalledWith({
            kind: 'openai',
            baseURL: provider.baseURL,
            apiKey: provider.apiKey,
            modelName: 'm'
        });
        expect(external.generate).toHaveBeenCalledWith({
            model: { modelId: 'fake' },
            prompt: 'ping',
            maxOutputTokens: 1
        });
        external.generate.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce('unavailable');
        expect(
            (await request('providers/demo/test', 'POST', { model: 'override', apiKey: 'temporary' })).data
        ).toMatchObject({ error: 'Error: offline' });
        expect(external.model).toHaveBeenLastCalledWith(
            expect.objectContaining({ modelName: 'override', apiKey: 'temporary' })
        );
        expect((await request('providers/demo/test', 'POST', {})).data).toMatchObject({ error: 'unavailable' });
    });

    it('app, environment and import/export preserve validation and key-only views', async () => {
        expect(
            (
                await request('app', 'PUT', {
                    defaultAgentMode: 'progressive',
                    autoCompactEnabled: false,
                    autoCompactThreshold: 80
                })
            ).data
        ).toMatchObject({ defaultAgentMode: 'progressive', autoCompactThreshold: 80 });
        expect((await request('app')).data).toMatchObject({ autoCompactEnabled: false });
        await request('env', 'POST', { key: 'HTTP_TEST_TOKEN', value: 'env-test-secret' });
        expect((await request('env')).data).toMatchObject({ keys: expect.arrayContaining(['HTTP_TEST_TOKEN']) });
        expect(JSON.stringify(await request('env'))).not.toContain('env-test-secret');
        await request('env', 'POST', { key: 'API_AUTH_TOKEN', value: 'blocked' }, 400);
        expect((await request('env/HTTP_TEST_TOKEN', 'DELETE')).data).toMatchObject({ removed: true });
        expect(
            (
                await request('import', 'POST', {
                    model: { providers: [provider], activeModel: 'demo/m' },
                    env: { IMPORT_TEST: 'hidden' },
                    app: { defaultAgentMode: 'routed' }
                })
            ).data
        ).toEqual({ imported: true, envNeedsRestart: true });
        expect((await request('import', 'POST', { app: {} })).data).toMatchObject({ envNeedsRestart: false });
        expect((await request('model')).data).toMatchObject({ providers: [{ name: 'demo' }] });
        expect((await request('export')).data).toMatchObject({ model: { providers: [{ apiKey: '' }] } });
        expect((await request('export')).data).toMatchObject({ env: { IMPORT_TEST: '' } });
        expect(JSON.stringify(await request('export'))).not.toContain('hidden');
        await request('import', 'POST', { web: { blockedHosts: ['https://bad.example/path'] } }, 400);
        await request('import', 'POST', { memory: { enabled: 'no' } }, 400);
        await request('import', 'POST', { web: { fetchEnabled: false }, memory: { autoDream: false } });
        expect((await request('export')).data).toMatchObject({
            web: { fetchEnabled: false },
            memory: { autoDream: false }
        });
    });

    it('web tests forward the saved policy, clamp previews and format errors without network access', async () => {
        const config = {
            enabled: false,
            fetchEnabled: false,
            allowedHosts: ['example.test'],
            blockedHosts: ['private.test'],
            requireApproval: 'always',
            timeoutMs: 1200,
            maxBytes: 65536,
            maxChars: 4000
        };
        expect((await request('web', 'PUT', config)).data).toEqual(config);
        expect((await request('web')).data).toEqual(config);
        const result = (await request('web/test', 'POST', { url: ' https://example.test/page ' })).data;
        expect(result).toEqual({ ok: true, detail: 'Page · 4 字符', ms: expect.any(Number) });
        expect(external.fetchPage).toHaveBeenLastCalledWith('https://example.test/page', {
            allowedHosts: config.allowedHosts,
            blockedHosts: config.blockedHosts,
            timeoutMs: 1200,
            maxBytes: 65536,
            maxChars: 2000
        });
        external.fetchPage.mockResolvedValueOnce({ content: 'short', truncated: true });
        expect((await request('web/test', 'POST', { url: 'x' })).data).toMatchObject({ detail: '5 字符（已截断）' });
        for (const [error, detail] of [
            [new WebAccessError('EMPTY_CONTENT', '网页没有可读正文'), 'EMPTY_CONTENT: 网页没有可读正文'],
            [new WebAccessError('NETWORK_ERROR', '响应解压失败'), 'NETWORK_ERROR: 响应解压失败'],
            [new WebAccessError('NETWORK_ERROR', 'denied'), 'NETWORK_ERROR: denied'],
            [new Error('plain'), 'plain'],
            ['string failure', 'string failure']
        ] as const) {
            external.fetchPage.mockRejectedValueOnce(error);
            expect((await request('web/test', 'POST', { url: 'x' })).data).toEqual({
                ok: false,
                detail,
                ms: expect.any(Number)
            });
        }
    });

    it('dependency failures use safe stable 500 messages instead of leaking stored keys', async () => {
        for (const [fn, path, method, body] of [
            ['addProvider', 'providers', 'POST', provider],
            ['updateProvider', 'providers/demo', 'PUT', {}],
            ['deleteProvider', 'providers/demo', 'DELETE', undefined],
            ['setActiveModel', 'model/active', 'PUT', { activeModel: 'demo/m' }],
            ['updateAppSettings', 'app', 'PUT', {}],
            ['importSettings', 'import', 'POST', {}],
            ['setEnvVar', 'env', 'POST', { key: 'SAFE_TEST', value: 'x' }],
            ['updateWebSettings', 'web', 'PUT', {}]
        ] as const) {
            const spy = vi.spyOn(settingsStore, fn).mockImplementation(() => {
                throw new Error('private-test-secret');
            });
            const result = await request(path, method, body, 500);
            expect(result.message).toContain('请查看后端日志');
            expect(JSON.stringify(result)).not.toContain('private-test-secret');
            spy.mockRestore();
        }
    });
});
