import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/http/middleware/error-handler';
import { createHooksRouter } from '@/http/routes/hooks';
import type * as hooksModule from '@/modules/hooks';

const fakes = vi.hoisted(() => ({ view: vi.fn(), trust: vi.fn(), audit: vi.fn() }));
vi.mock('@/modules/hooks', async (original) => ({
    ...(await original<typeof hooksModule>()),
    hooksView: fakes.view,
    updateHooksTrust: fakes.trust,
    readHookAudit: fakes.audit
}));

const app = new Hono();
app.route('/', createHooksRouter());
app.onError(errorHandler);

async function call(url: string, method = 'GET', body?: unknown) {
    const response = await app.request(`/api/${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    return {
        status: response.status,
        json: (await response.json()) as { code: number; data?: unknown; message?: string }
    };
}

beforeEach(() => vi.clearAllMocks());

describe('hooks HTTP boundary', () => {
    it('serves the view, trusts a hash, toggles and maps stale hashes to 409', async () => {
        fakes.view.mockReturnValue({ status: 'untrusted' });
        expect((await call('hooks')).json).toEqual({ code: 0, data: { status: 'untrusted' } });
        const hash = 'a'.repeat(64);
        fakes.trust.mockReturnValue({ status: 'active' });
        expect((await call('hooks/trust', 'PUT', { hash, enabled: true })).json.data).toEqual({ status: 'active' });
        expect(fakes.trust).toHaveBeenCalledWith({ hash, enabled: true });
        const { HooksTrustError } = await vi.importActual<typeof hooksModule>('@/modules/hooks');
        fakes.trust.mockImplementationOnce(() => {
            throw new HooksTrustError('配置已变化，请刷新后重新确认');
        });
        expect(await call('hooks/trust', 'PUT', { hash })).toEqual({
            status: 409,
            json: { code: 409, message: '配置已变化，请刷新后重新确认' }
        });
        fakes.trust.mockImplementationOnce(() => {
            throw new Error('disk');
        });
        expect((await call('hooks/trust', 'PUT', { enabled: false })).status).toBe(500);
        for (const body of [{}, { hash: 'short' }, { enabled: 'yes' }, '{'])
            expect((await call('hooks/trust', 'PUT', body)).status).toBe(400);
    });

    it('bounds the audit limit', async () => {
        fakes.audit.mockResolvedValue([]);
        await call('hooks/audit');
        await call('hooks/audit?limit=999');
        await call('hooks/audit?limit=0');
        await call('hooks/audit?limit=abc');
        expect(fakes.audit.mock.calls.map((c) => c[0])).toEqual([50, 200, 1, 50]);
    });
});
