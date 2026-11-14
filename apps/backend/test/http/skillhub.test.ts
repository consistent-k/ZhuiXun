import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as settings from '@/config/settings-store';
import { errorHandler } from '@/http/middleware/error-handler';
import { createSkillHubRouter } from '@/http/routes/skillhub';
import { MCPClientManager } from '@/modules/mcp';
import { SkillRegistry } from '@/modules/skills';
import type * as skillsModule from '@/modules/skills';

const market = vi.hoisted(() => ({
    search: vi.fn(),
    detail: vi.fn(),
    versions: vi.fn(),
    install: vi.fn(),
    mapSearch: vi.fn(),
    mapDetail: vi.fn()
}));
vi.mock('@/modules/skills', async (original) => ({
    ...(await original<typeof skillsModule>()),
    searchSkillsRaw: market.search,
    fetchSkillDetailRaw: market.detail,
    fetchSkillVersionsRaw: market.versions,
    installMarketSkill: market.install,
    mapSearch: market.mapSearch,
    mapDetail: market.mapDetail
}));
const registry = new SkillRegistry(new MCPClientManager([]), '/fake/skills');
let ready = true;
const app = new Hono();
app.route(
    '/',
    createSkillHubRouter(() => (ready ? registry : undefined))
);
app.onError(errorHandler);
async function req(url: string, method = 'GET', body?: unknown, status = 200) {
    const response = await app.request(`/api/skillhub/${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    expect(response.status).toBe(status);
    const result = (await response.json()) as { code: number; data: unknown; message: string };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result;
}
beforeEach(() => {
    vi.restoreAllMocks();
    for (const fn of Object.values(market)) fn.mockReset();
    ready = true;
    vi.spyOn(registry, 'hasUserDir').mockReturnValue(true);
    vi.spyOn(registry, 'listMetadata').mockReturnValue([
        {
            id: 'LOCAL',
            name: 'Local',
            description: '',
            dirPath: '/fake',
            loaded: false,
            source: 'user',
            editable: true,
            disabled: false,
            sourceCanonical: '@TEAM/LOCAL'
        }
    ]);
    market.search.mockResolvedValue({ items: [] });
    market.detail.mockResolvedValue({ name: 'demo' });
    market.versions.mockResolvedValue({ versions: [] });
    market.mapSearch.mockReturnValue({ items: [], total: 0 });
    market.mapDetail.mockReturnValue({ id: 'demo', installed: false });
    market.install.mockResolvedValue({ id: 'demo', slug: 'demo', version: '1' });
    settings.updateSkillhubSettings({ apiBase: 'https://market.test', maxResults: 12, timeoutMs: 1500 });
});

describe('SkillHub real router with offline marketplace boundary', () => {
    it('reads/writes config and reports persistence failure with no network', async () => {
        expect((await req('config')).data).toEqual({ apiBase: 'https://market.test', maxResults: 12, timeoutMs: 1500 });
        expect(
            (await req('config', 'PUT', { apiBase: ' https://new.test ', maxResults: '20', timeoutMs: '2000' })).data
        ).toEqual({ apiBase: 'https://new.test', maxResults: 20, timeoutMs: 2000 });
        const malformed = await app.request('/api/skillhub/config', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{'
        });
        expect(malformed.status).toBe(200);
        expect(((await malformed.json()) as { code: number }).code).toBe(0);
        vi.spyOn(settings, 'updateSkillhubSettings').mockImplementationOnce(() => {
            throw new Error('disk private detail');
        });
        expect((await req('config', 'PUT', {}, 500)).message).toBe('保存 SkillHub 配置失败');
    });

    it('guards registry readiness and read-only installation', async () => {
        ready = false;
        await req('search', 'GET', undefined, 503);
        await req('skills/demo', 'GET', undefined, 503);
        await req('install', 'POST', {}, 503);
        ready = true;
        vi.mocked(registry.hasUserDir).mockReturnValue(false);
        await req('install', 'POST', { slug: 'demo' }, 403);
        expect(market.install).not.toHaveBeenCalled();
    });

    it('normalizes search filters, clamps pagination and supplies canonical installation identity', async () => {
        expect(
            (await req('search?q=%20topic%20&category=%20cat%20&source=hub&sort=popular&limit=999&offset=-3')).data
        ).toEqual({ items: [], total: 0 });
        expect(market.search).toHaveBeenLastCalledWith(
            { apiBase: 'https://market.test', timeoutMs: 1500 },
            { q: 'topic', category: 'cat', source: 'hub', sort: 'popular', limit: 80, offset: 0 }
        );
        expect(market.mapSearch).toHaveBeenLastCalledWith(
            { items: [] },
            { query: 'topic', category: 'cat', limit: 80, offset: 0, installed: new Set(['local', '@team/local']) }
        );
        await req('search?limit=nope&offset=nope');
        expect(market.search).toHaveBeenLastCalledWith(expect.anything(), {
            q: '',
            category: undefined,
            source: undefined,
            sort: undefined,
            limit: 12,
            offset: 0
        });
        await req('search?limit=0&offset=999999');
        expect(market.search).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ limit: 1, offset: 100000 })
        );
        for (const error of [new Error('offline'), 'offline']) {
            market.search.mockRejectedValueOnce(error);
            expect((await req('search', 'GET', undefined, 502)).message).toBe('SkillHub 搜索失败：offline');
        }
    });

    it('details validate slugs, tolerate version failure, return 404 for absent mappings and propagate upstream errors', async () => {
        await req('skills/bad%21', 'GET', undefined, 400);
        expect((await req('skills/demo?canonicalName=%40team%2Fdemo')).data).toEqual({ id: 'demo', installed: false });
        expect(market.detail).toHaveBeenLastCalledWith(
            { apiBase: 'https://market.test', timeoutMs: 1500 },
            'demo',
            undefined,
            '@team/demo'
        );
        expect(market.versions).toHaveBeenLastCalledWith(expect.anything(), 'demo', undefined, '@team/demo');
        market.versions.mockRejectedValueOnce(new Error('versions unavailable'));
        await req('skills/demo');
        expect(market.mapDetail).toHaveBeenLastCalledWith({ name: 'demo' }, {}, new Set(['local', '@team/local']));
        market.mapDetail.mockReturnValueOnce(null);
        await req('skills/demo', 'GET', undefined, 404);
        for (const error of [new Error('offline'), 'offline']) {
            market.detail.mockRejectedValueOnce(error);
            expect((await req('skills/demo', 'GET', undefined, 502)).message).toBe('获取技能详情失败：offline');
        }
    });

    it('installs with typed optional arguments and maps content failures vs upstream failures', async () => {
        expect(
            (
                await req('install', 'POST', {
                    slug: 'demo',
                    version: '1',
                    canonicalName: '@team/demo',
                    displayName: 'Display'
                })
            ).data
        ).toEqual({ id: 'demo', slug: 'demo', version: '1' });
        expect(market.install).toHaveBeenLastCalledWith(
            registry,
            { apiBase: 'https://market.test', timeoutMs: 1500 },
            'demo',
            '1',
            undefined,
            '@team/demo',
            'Display'
        );
        await req('install', 'POST', { slug: 'demo', version: 1, canonicalName: null, displayName: [] });
        expect(market.install).toHaveBeenLastCalledWith(
            registry,
            expect.anything(),
            'demo',
            undefined,
            undefined,
            undefined,
            undefined
        );
        await req('install', 'POST', {}, 400);
        const response = await app.request('/api/skillhub/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{'
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { code: number }).code).toBe(400);
        for (const message of ['invalid slug', '缺 SKILL.md', '超限', '非法路径', '不是 zip', '无效']) {
            market.install.mockRejectedValueOnce(new Error(message));
            expect((await req('install', 'POST', { slug: 'demo' }, 400)).message).toBe(message);
        }
        market.install.mockRejectedValueOnce('upstream down');
        expect((await req('install', 'POST', { slug: 'demo' }, 502)).message).toBe('upstream down');
    });
});
