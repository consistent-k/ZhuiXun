import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    downloadSkillZip,
    fetchSkillDetailRaw,
    fetchSkillVersionsRaw,
    namespaceFromCanonical,
    sanitizeSlug,
    sanitizeVersion,
    searchSkillsRaw
} from '@/modules/skills/skillhub/client';

const cfg = { apiBase: 'https://skillhub.invalid/', timeoutMs: 1000 };

function fakeFetch(response: Response) {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', transport);
    return transport;
}

function requestOf(transport: ReturnType<typeof fakeFetch>) {
    const [url, init] = transport.mock.calls[0];
    return { url: new URL(String(url)), init };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('SkillHub client input boundaries', () => {
    it.each([
        ['  @Team/GOOD_Skill/  ', 'good_skill'],
        ['@GOOD-Skill', 'good-skill'],
        ['a'.repeat(128), 'a'.repeat(128)]
    ])('normalizes slug %s', (input, expected) => {
        expect(sanitizeSlug(input)).toBe(expected);
    });

    it.each(['', ' ', '..', '../escape', 'x/../skill', 'a\\b', 'a\0b', '-skill', 'skill?', 'a'.repeat(129), '@///'])(
        'rejects unsafe slug %j before any fetch',
        (input) => {
            const transport = vi.fn<typeof fetch>();
            vi.stubGlobal('fetch', transport);
            expect(() => fetchSkillDetailRaw(cfg, input)).toThrow('无效 slug');
            expect(transport).not.toHaveBeenCalled();
        }
    );

    it.each([
        [' @Team_Name/skill ', '@Team_Name'],
        ['@team', '@team'],
        ['@9team/skill', '@9team'],
        ['team/skill', ''],
        ['@team/a/b', ''],
        ['@-team/skill', ''],
        [undefined, '']
    ])('extracts canonical namespace %j', (input, expected) => {
        expect(namespaceFromCanonical(input)).toBe(expected);
    });

    it.each([
        [undefined, ''],
        [' V1.2.0-beta+build_2 ', '1.2.0-beta+build_2'],
        ['v', ''],
        [123, '123'],
        ['a'.repeat(32), 'a'.repeat(32)]
    ])('normalizes version %j', (input, expected) => {
        expect(sanitizeVersion(input)).toBe(expected);
    });

    it.each(['../x', '_first', 'a b', 'a'.repeat(33)])('rejects unsafe version %s', (input) => {
        expect(() => sanitizeVersion(input)).toThrow('无效版本');
    });
});

describe('SkillHub client fake fetch transport', () => {
    it('sends real upstream search keys, pagination, headers and caller signal', async () => {
        const payload = { data: { skills: [{ slug: 'sample' }], total: 8 } };
        const transport = fakeFetch(Response.json(payload));
        const controller = new AbortController();
        await expect(
            searchSkillsRaw(
                cfg,
                {
                    q: '中文 & query',
                    category: 'education',
                    source: 'community',
                    sort: 'downloads',
                    limit: 3,
                    offset: 7
                },
                controller.signal
            )
        ).resolves.toEqual(payload);
        const { url, init } = requestOf(transport);
        expect(url.origin + url.pathname).toBe('https://skillhub.invalid/api/skills');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            keyword: '中文 & query',
            category: 'education',
            source: 'community',
            sortBy: 'downloads',
            order: 'desc',
            page: '3',
            pageSize: '3'
        });
        expect(init).toEqual({
            headers: { 'User-Agent': 'zhuixun-SkillHub/1.0', Accept: 'application/json' },
            signal: controller.signal
        });
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it.each([
        [0, -2, '12', '1'],
        [-9, 10, '1', '11'],
        [101, 250, '100', '3'],
        [3.9, 0, '3', '1']
    ])('bounds page size %s and offset %s', async (limit, offset, size, page) => {
        const transport = fakeFetch(Response.json({}));
        const signal = new AbortController().signal;
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
        await searchSkillsRaw({ ...cfg, apiBase: 'https://skillhub.invalid' }, { limit, offset });
        expect(Object.fromEntries(requestOf(transport).url.searchParams)).toEqual({
            sortBy: 'score',
            order: 'desc',
            page,
            pageSize: size
        });
        expect(timeout).toHaveBeenCalledWith(1000);
        expect(requestOf(transport).init?.signal).toBe(signal);
    });

    it.each([
        [fetchSkillDetailRaw, '/api/v1/skills/my-skill'],
        [fetchSkillVersionsRaw, '/api/v1/skills/my-skill/versions']
    ])('encodes namespace for %s', async (read, pathname) => {
        const transport = fakeFetch(Response.json({ data: { ok: true } }));
        await expect(read(cfg, '@team/My-Skill', undefined, '@other/my-skill')).resolves.toEqual({
            data: { ok: true }
        });
        const { url } = requestOf(transport);
        expect(url.pathname).toBe(pathname);
        expect(url.search).toBe('?namespace=%40other');
    });

    it.each([fetchSkillDetailRaw, fetchSkillVersionsRaw])('omits namespace when not canonical', async (read) => {
        const transport = fakeFetch(Response.json({}));
        await read(cfg, 'sample', undefined, 'not-canonical');
        expect(requestOf(transport).url.search).toBe('');
    });

    it('propagates upstream HTTP, invalid JSON and transport failures', async () => {
        fakeFetch(new Response('unavailable', { status: 503 }));
        await expect(searchSkillsRaw(cfg, { limit: 12, offset: 0 })).rejects.toThrow('SkillHub 请求失败 HTTP 503');
        fakeFetch(new Response('not json'));
        await expect(fetchSkillDetailRaw(cfg, 'sample')).rejects.toBeInstanceOf(SyntaxError);
        const failure = new DOMException('cancelled', 'AbortError');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(failure));
        await expect(fetchSkillVersionsRaw(cfg, 'sample')).rejects.toBe(failure);
    });

    it('requests follow for 302→COS and accepts final COS binary response', async () => {
        // fetch 的重定向属于 transport；fake 返回 COS 最终响应，验证调用方确实启用 follow，不伪造客户端重定向逻辑。
        const response = new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
            headers: { 'content-type': 'application/octet-stream' }
        });
        Object.defineProperty(response, 'url', { value: 'https://bucket.cos.invalid/archive.zip?signature=fake' });
        Object.defineProperty(response, 'redirected', { value: true });
        const transport = fakeFetch(response);
        const signal = new AbortController().signal;
        await expect(downloadSkillZip(cfg, 'SAMPLE', 'v1.2', signal, '@team/sample')).resolves.toEqual(
            new Uint8Array([0x50, 0x4b, 3, 4])
        );
        const { url, init } = requestOf(transport);
        expect(url.pathname).toBe('/api/v1/download');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            slug: 'sample',
            source: 'zhuixun',
            version: '1.2',
            namespace: '@team'
        });
        expect(init).toEqual({ headers: { 'User-Agent': 'zhuixun-SkillHub/1.0' }, redirect: 'follow', signal });
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['application/zip', [1]],
        ['APPLICATION/OCTET-STREAM', [1, 2]],
        ['text/plain', [0x50, 0x4b]],
        ['', [0x50, 0x4b, 3]]
    ])('accepts zip content-type or PK signature: %s', async (contentType, bytes) => {
        const transport = fakeFetch(
            new Response(new Uint8Array(bytes), {
                headers: contentType ? { 'content-type': contentType } : {}
            })
        );
        const signal = new AbortController().signal;
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
        await expect(downloadSkillZip(cfg, 'sample')).resolves.toEqual(new Uint8Array(bytes));
        expect(requestOf(transport).url.searchParams.has('version')).toBe(false);
        expect(requestOf(transport).url.searchParams.has('namespace')).toBe(false);
        expect(requestOf(transport).init?.signal).toBe(signal);
        expect(timeout).toHaveBeenCalledWith(16000);
    });

    it.each([[], [0x50], [0x50, 0x00], [60, 104, 116, 109, 108]])('rejects non-zip bytes %j', async (...bytes) => {
        fakeFetch(new Response(new Uint8Array(bytes), { headers: { 'content-type': 'text/html' } }));
        await expect(downloadSkillZip(cfg, 'sample')).rejects.toThrow('下载结果不是 zip 包：sample');
    });

    it.each([302, 403, 500])('reports download HTTP %s rather than accepting the body', async (status) => {
        fakeFetch(new Response('denied', { status, headers: { location: 'https://bucket.cos.invalid/archive.zip' } }));
        await expect(downloadSkillZip(cfg, 'sample')).rejects.toThrow(`SkillHub 下载失败 HTTP ${status}`);
    });

    it('accepts exactly 20 MiB and rejects one byte above the hard download limit', async () => {
        const max = 20 * 1024 * 1024;
        fakeFetch(new Response(new Uint8Array(max), { headers: { 'content-type': 'application/zip' } }));
        expect((await downloadSkillZip(cfg, 'sample')).byteLength).toBe(max);
        fakeFetch(new Response(new Uint8Array(max + 1), { headers: { 'content-type': 'application/zip' } }));
        await expect(downloadSkillZip(cfg, 'sample')).rejects.toThrow('技能包体积超限');
    });

    it('rejects invalid download arguments without contacting transport', async () => {
        const transport = fakeFetch(new Response());
        await expect(downloadSkillZip(cfg, '../escape')).rejects.toThrow('无效 slug');
        await expect(downloadSkillZip(cfg, 'sample', '../version')).rejects.toThrow('无效版本');
        expect(transport).not.toHaveBeenCalled();
    });
});
