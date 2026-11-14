import type { Channel, ChannelMessageEvent } from '@zhuixun/channels-core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as settings from '@/config/settings-store';
import { errorHandler } from '@/http/middleware/error-handler';
import { createChannelsRouter } from '@/http/routes/channels';

const state = vi.hoisted(() => ({
    list: vi.fn(),
    get: vi.fn(),
    running: vi.fn(),
    uptime: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn()
}));
vi.mock('@/modules/channels', () => ({
    channelManager: {
        list: state.list,
        get: state.get,
        isRunning: state.running,
        getUptime: state.uptime,
        start: state.start,
        stop: state.stop
    },
    channelEvents: { subscribe: state.subscribe }
}));
const channel: Channel = {
    id: 'demo',
    name: 'Demo',
    status: 'idle',
    start: vi.fn(),
    stop: vi.fn(),
    isConfigured: vi.fn(),
    getStatusInfo: () => ['info'],
    bind: vi.fn(),
    startQrLogin: vi.fn(),
    pollQrLogin: vi.fn(),
    logout: vi.fn()
};
const app = new Hono();
app.route('/', createChannelsRouter());
app.onError(errorHandler);
async function req(url: string, method = 'GET', body?: unknown, status = 200) {
    const response = await app.request(`/api/channels${url}`, {
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
    vi.resetAllMocks();
    state.get.mockReturnValue(channel);
    state.list.mockReturnValue([channel]);
    state.running.mockReturnValue(false);
    state.uptime.mockReturnValue(null);
    vi.mocked(channel.isConfigured).mockReturnValue(true);
    vi.mocked(channel.bind!).mockResolvedValue(['bound']);
    vi.mocked(channel.startQrLogin!).mockResolvedValue({ sessionKey: 'key', qrcodeUrl: 'qr', message: 'scan' });
    vi.mocked(channel.pollQrLogin!).mockResolvedValue({ connected: true, message: 'bound' });
    vi.mocked(channel.logout!).mockResolvedValue(['unbound']);
    state.subscribe.mockReturnValue(state.unsubscribe);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('channels real control-plane HTTP and SSE', () => {
    it('lists runtime capability flags and handles all missing/unsupported cases', async () => {
        expect((await req('')).data).toEqual([
            {
                id: 'demo',
                name: 'Demo',
                status: 'idle',
                configured: true,
                running: false,
                uptimeMs: null,
                info: ['info'],
                supportsBind: true,
                supportsQr: true
            }
        ]);
        state.get.mockReturnValue(undefined);
        for (const [url, method] of [
            ['/demo/start', 'POST'],
            ['/demo/stop', 'POST'],
            ['/demo/bind', 'POST'],
            ['/demo/bind/qr', 'POST'],
            ['/demo/bind/status', 'GET'],
            ['/demo/unbind', 'POST']
        ])
            await req(url!, method!, undefined, 404);
        state.get.mockReturnValue({
            ...channel,
            bind: undefined,
            startQrLogin: undefined,
            pollQrLogin: undefined,
            logout: undefined
        });
        for (const [url, method] of [
            ['/demo/bind', 'POST'],
            ['/demo/bind/qr', 'POST'],
            ['/demo/bind/status', 'GET']
        ])
            await req(url!, method!, undefined, 400);
        expect((await req('/demo/unbind', 'POST')).data).toEqual({ ok: true, info: ['该渠道不支持解绑'] });
        state.list.mockReturnValue([{ ...channel, bind: undefined, startQrLogin: undefined }]);
        expect((await req('')).data).toMatchObject([{ supportsBind: false, supportsQr: false }]);
    });

    it('starts/stops with configured/idempotent gates and handles non-Error dependency failures', async () => {
        vi.mocked(channel.isConfigured).mockReturnValueOnce(false);
        await req('/demo/start', 'POST', undefined, 400);
        expect(state.start).not.toHaveBeenCalled();
        state.running.mockReturnValueOnce(true);
        expect((await req('/demo/start', 'POST')).data).toEqual({ ok: true, status: 'idle' });
        expect(state.start).not.toHaveBeenCalled();
        await req('/demo/start', 'POST');
        expect(state.start).toHaveBeenCalledWith('demo');
        for (const error of [new Error('start failed'), 'start failed']) {
            state.start.mockRejectedValueOnce(error);
            expect((await req('/demo/start', 'POST', undefined, 500)).message).toBe('start failed');
        }
        expect((await req('/demo/stop', 'POST')).data).toEqual({ ok: true });
        expect(state.stop).toHaveBeenCalledWith('demo');
        state.stop.mockRejectedValueOnce(new Error('stop failed'));
        expect((await req('/demo/stop', 'POST', undefined, 500)).message).toBe('stop failed');
    });

    it('binds/forms/QR/status/logout and rejects rebinding running channels', async () => {
        expect((await req('/demo/bind', 'POST', { token: 'fake-token' })).data).toEqual({ ok: true, info: ['bound'] });
        expect(channel.bind).toHaveBeenLastCalledWith({ token: 'fake-token' });
        const malformed = await app.request('/api/channels/demo/bind', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{'
        });
        expect(malformed.status).toBe(200);
        expect(channel.bind).toHaveBeenLastCalledWith({});
        expect((await req('/demo/bind/qr', 'POST')).data).toEqual({
            sessionKey: 'key',
            qrcodeUrl: 'qr',
            message: 'scan'
        });
        await req('/demo/bind/status', 'GET', undefined, 400);
        expect((await req('/demo/bind/status?sessionKey=key')).data).toEqual({ connected: true, message: 'bound' });
        expect(channel.pollQrLogin).toHaveBeenCalledWith('key');
        expect((await req('/demo/unbind', 'POST')).data).toEqual({ ok: true, info: ['unbound'] });
        state.running.mockReturnValue(true);
        for (const url of ['/demo/bind', '/demo/bind/qr', '/demo/unbind']) await req(url, 'POST', {}, 409);
        state.running.mockReturnValue(false);
        vi.mocked(channel.bind!).mockRejectedValueOnce(new Error('bind failed'));
        await req('/demo/bind', 'POST', {}, 500);
    });

    it('reads/writes settings through real configuration and reports dependency failures', async () => {
        const patch = { plugins: ['demo'] };
        expect((await req('/settings', 'PUT', patch)).data).toMatchObject(patch);
        expect((await req('/settings')).data).toMatchObject(patch);
        const malformed = await app.request('/api/channels/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{'
        });
        expect(malformed.status).toBe(200);
        expect(((await malformed.json()) as { code: number }).code).toBe(0);
        vi.spyOn(settings, 'updateChannelsSettings').mockImplementationOnce(() => {
            throw new Error('save failed');
        });
        await req('/settings', 'PUT', {}, 500);
    });

    it('consumes event and heartbeat SSE then cancels and removes subscriber', async () => {
        vi.useFakeTimers();
        let listener: ((event: ChannelMessageEvent) => void) | undefined;
        state.subscribe.mockImplementation((fn) => {
            listener = fn;
            return state.unsubscribe;
        });
        const controller = new AbortController();
        const response = await app.request('/api/channels/events', { signal: controller.signal });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const reader = response.body!.getReader();
        try {
            const event = {
                type: 'inbound' as const,
                channelId: 'demo',
                channelName: 'Demo',
                userId: 'u',
                sessionId: 'conv',
                text: 'hello',
                ts: 1
            };
            listener!(event);
            const first = new TextDecoder().decode((await reader.read()).value);
            expect(first).toContain('event: channel');
            expect(first).toContain(JSON.stringify(event));
            await vi.advanceTimersByTimeAsync(25_000);
            expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ping');
            controller.abort();
            await reader.cancel();
            expect(state.unsubscribe).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(25_000);
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }
    });
});
