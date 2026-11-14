import type { WebSettingsView } from '@zhuixun/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { createWebTools } from '@/agent/tools/web-tools';
import { getWebSettings } from '@/config/settings-store';
import { fetchReadablePage, WebAccessError } from '@/platform/web';

vi.mock('@/config/settings-store', () => ({ getWebSettings: vi.fn() }));
vi.mock('@/platform/web', async () => {
    const { WebAccessError } = await import('@/platform/web/url-policy');
    return { WebAccessError, fetchReadablePage: vi.fn() };
});

const options = { toolCallId: 'web-call', messages: [], context: {} };
const settings: WebSettingsView = {
    enabled: true,
    fetchEnabled: true,
    requireApproval: 'never',
    allowedHosts: ['example.test'],
    blockedHosts: ['blocked.example.test'],
    timeoutMs: 100,
    maxBytes: 1024,
    maxChars: 3000
};
const page = {
    url: 'https://example.test/input',
    finalUrl: 'https://example.test/final',
    title: 'Synthetic document',
    contentType: 'text/markdown',
    content: 'Synthetic content',
    truncated: true,
    bytesRead: 128,
    fetchedAt: '2026-01-01T00:00:00.000Z'
};

beforeEach(() => {
    vi.mocked(getWebSettings)
        .mockReset()
        .mockReturnValue({ ...settings });
    vi.mocked(fetchReadablePage).mockReset().mockResolvedValue(page);
});

async function fetchTool(input: { url: string; maxChars?: number }) {
    return createWebTools().WebFetch.execute!(input, options);
}

describe('agent WebFetch tool execute', () => {
    it.each([
        [false, true],
        [true, false],
        [false, false]
    ])('enforces current enabled=%s fetchEnabled=%s settings before any transport', async (enabled, fetchEnabled) => {
        vi.mocked(getWebSettings).mockReturnValue({ ...settings, enabled, fetchEnabled });
        expect(await fetchTool({ url: page.url })).toEqual({
            ok: false,
            code: 'DISABLED',
            message: expect.stringContaining('设置 → Web 访问')
        });
        expect(fetchReadablePage).not.toHaveBeenCalled();
    });

    it('maps the full host/timeout/size policy and preserves the extracted page including truncation', async () => {
        expect(await fetchTool({ url: page.url })).toEqual({ ok: true, ...page });
        expect(fetchReadablePage).toHaveBeenCalledWith(page.url, {
            allowedHosts: settings.allowedHosts,
            blockedHosts: settings.blockedHosts,
            timeoutMs: settings.timeoutMs,
            maxBytes: settings.maxBytes,
            maxChars: settings.maxChars
        });
        expect(await fetchTool({ url: page.url, maxChars: 1000 })).toEqual({ ok: true, ...page });
        expect(fetchReadablePage).toHaveBeenLastCalledWith(page.url, expect.objectContaining({ maxChars: 1000 }));
    });

    it('reads settings per execution, not at registration time', async () => {
        const tools = createWebTools();
        vi.mocked(getWebSettings).mockReturnValue({ ...settings, enabled: false });
        expect(await tools.WebFetch.execute!({ url: page.url }, options)).toMatchObject({ code: 'DISABLED' });
        expect(fetchReadablePage).not.toHaveBeenCalled();
        vi.mocked(getWebSettings).mockReturnValue(settings);
        expect(await tools.WebFetch.execute!({ url: page.url }, options)).toMatchObject({ ok: true });
    });

    it.each([
        new WebAccessError('BLOCKED_HOST', 'blocked host'),
        new WebAccessError('HTTP_ERROR', 'not found', 404),
        new WebAccessError('EMPTY_CONTENT', '没有可读正文'),
        new WebAccessError('NETWORK_ERROR', '响应解压失败')
    ])('preserves structured access error %s', async (error) => {
        vi.mocked(fetchReadablePage).mockRejectedValueOnce(error);
        expect(await fetchTool({ url: page.url })).toEqual({
            ok: false,
            code: error.code,
            message: error.message,
            status: error.status
        });
    });

    it('explains the response byte limit without retrying or weakening the configured policy', async () => {
        vi.mocked(fetchReadablePage).mockRejectedValueOnce(new WebAccessError('TOO_LARGE', '响应超过上限'));
        const result = await fetchTool({ url: page.url, maxChars: 1000 });
        expect(result).toMatchObject({
            ok: false,
            code: 'TOO_LARGE',
            message: expect.stringContaining('设置 → Web 访问')
        });
        expect(result).toMatchObject({ message: expect.stringContaining('降低 maxChars 无法解决') });
        expect(fetchReadablePage).toHaveBeenCalledExactlyOnceWith(
            page.url,
            expect.objectContaining({ maxBytes: settings.maxBytes, maxChars: 1000 })
        );
    });

    it.each([new Error('sensitive transport details'), 'non-error failure'])(
        'sanitizes unexpected error %s',
        async (error) => {
            vi.mocked(fetchReadablePage).mockRejectedValueOnce(error);
            expect(await fetchTool({ url: page.url })).toEqual({
                ok: false,
                code: 'NETWORK_ERROR',
                message: '抓取失败，请稍后重试或换一个地址。'
            });
        }
    );

    it('only registers WebFetch and validates URL/maxChars boundaries', () => {
        const tools = createWebTools();
        expect(Object.keys(tools)).toEqual(['WebFetch']);
        const schema = tools.WebFetch.inputSchema as z.ZodType;
        expect(schema.safeParse({ url: '' }).success).toBe(false);
        for (const maxChars of [999, 100001, 1000.5]) {
            expect(schema.safeParse({ url: page.url, maxChars }).success).toBe(false);
        }
        for (const maxChars of [undefined, 1000, 100000]) {
            expect(schema.safeParse({ url: page.url, maxChars }).success).toBe(true);
        }
    });
});
