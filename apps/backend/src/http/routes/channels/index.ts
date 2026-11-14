/**
 * 渠道控制面 + 事件 SSE。
 * 控制面（列表/启停/绑定/解绑/配置）经 apiGuard；数据面（渠道↔IM）在 provider 内部出站，不经此。
 * SSE `/api/channels/events` 推 inbound/reply/error 给前端，驱动侧栏「渠道」分区刷新与未读。
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { getChannelsSettings, updateChannelsSettings, type ChannelsSettings } from '@/config/settings-store';
import type { ApiResponse } from '@/config/types';
import { channelManager } from '@/modules/channels';
import { channelEvents } from '@/modules/channels';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('ChannelRoutes');

/** SSE 心跳间隔：定期发 ping 保活，避免中间层断连。 */
const SSE_PING_MS = 25_000;

export function createChannelsRouter() {
    const channels = new Hono();

    /** GET /api/channels — 渠道列表 + 运行时状态。 */
    channels.get('/api/channels', (c) => {
        const data = channelManager.list().map((ch) => ({
            id: ch.id,
            name: ch.name,
            status: ch.status,
            configured: ch.isConfigured(),
            running: channelManager.isRunning(ch.id),
            uptimeMs: channelManager.getUptime(ch.id),
            info: ch.getStatusInfo(),
            supportsBind: typeof ch.bind === 'function',
            supportsQr: typeof ch.startQrLogin === 'function'
        }));
        return c.json({ code: 0, data } satisfies ApiResponse);
    });

    channels.post('/api/channels/:id/start', async (c) => {
        const id = c.req.param('id');
        const channel = channelManager.get(id);
        if (!channel) return c.json({ code: 404, message: `渠道 "${id}" 未注册` } satisfies ApiResponse, 404);
        if (!channel.isConfigured())
            return c.json({ code: 400, message: `渠道 "${channel.name}" 未配置，请先绑定` } satisfies ApiResponse, 400);
        if (channelManager.isRunning(id))
            return c.json({ code: 0, data: { ok: true, status: channel.status } } satisfies ApiResponse);
        try {
            await channelManager.start(id);
            return c.json({ code: 0, data: { ok: true, status: channel.status } } satisfies ApiResponse);
        } catch (err) {
            return c.json(
                { code: 500, message: err instanceof Error ? err.message : String(err) } satisfies ApiResponse,
                500
            );
        }
    });

    channels.post('/api/channels/:id/stop', async (c) => {
        const id = c.req.param('id');
        if (!channelManager.get(id))
            return c.json({ code: 404, message: `渠道 "${id}" 未注册` } satisfies ApiResponse, 404);
        await channelManager.stop(id);
        return c.json({ code: 0, data: { ok: true } } satisfies ApiResponse);
    });

    /** POST /api/channels/:id/bind — 表单绑定（Telegram: {token}；微信: {baseUrl, token}）。 */
    channels.post('/api/channels/:id/bind', async (c) => {
        const id = c.req.param('id');
        const channel = channelManager.get(id);
        if (!channel) return c.json({ code: 404, message: `渠道 "${id}" 未注册` } satisfies ApiResponse, 404);
        if (typeof channel.bind !== 'function')
            return c.json({ code: 400, message: `渠道 "${channel.name}" 不支持表单绑定` } satisfies ApiResponse, 400);
        if (channelManager.isRunning(id))
            return c.json({ code: 409, message: '请先停止渠道再重新绑定' } satisfies ApiResponse, 409);
        const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
        const info = await channel.bind(body);
        const ok = channel.isConfigured();
        return c.json({ code: 0, data: { ok, info } } satisfies ApiResponse);
    });

    /** POST /api/channels/:id/bind/qr — 发起扫码，返回二维码内容（前端渲染二维码图）。 */
    channels.post('/api/channels/:id/bind/qr', async (c) => {
        const id = c.req.param('id');
        const channel = channelManager.get(id);
        if (!channel) return c.json({ code: 404, message: `渠道 "${id}" 未注册` } satisfies ApiResponse, 404);
        if (typeof channel.startQrLogin !== 'function')
            return c.json({ code: 400, message: `渠道 "${channel.name}" 不支持扫码绑定` } satisfies ApiResponse, 400);
        if (channelManager.isRunning(id))
            return c.json({ code: 409, message: '请先停止渠道再重新绑定' } satisfies ApiResponse, 409);
        const data = await channel.startQrLogin();
        return c.json({ code: 0, data } satisfies ApiResponse);
    });

    /** GET /api/channels/:id/bind/status?sessionKey= — 轮询扫码结果。 */
    channels.get('/api/channels/:id/bind/status', async (c) => {
        const id = c.req.param('id');
        const channel = channelManager.get(id);
        if (!channel) return c.json({ code: 404, message: `渠道 "${id}" 未注册` } satisfies ApiResponse, 404);
        if (typeof channel.pollQrLogin !== 'function')
            return c.json({ code: 400, message: `渠道 "${channel.name}" 不支持扫码绑定` } satisfies ApiResponse, 400);
        const sessionKey = c.req.query('sessionKey') ?? '';
        if (!sessionKey) return c.json({ code: 400, message: '缺少 sessionKey' } satisfies ApiResponse, 400);
        const data = await channel.pollQrLogin(sessionKey);
        return c.json({ code: 0, data } satisfies ApiResponse);
    });

    channels.post('/api/channels/:id/unbind', async (c) => {
        const id = c.req.param('id');
        const channel = channelManager.get(id);
        if (!channel) return c.json({ code: 404, message: `渠道 "${id}" 未注册` } satisfies ApiResponse, 404);
        if (channelManager.isRunning(id))
            return c.json({ code: 409, message: '请先停止渠道再解绑' } satisfies ApiResponse, 409);
        const info = channel.logout ? await channel.logout() : ['该渠道不支持解绑'];
        return c.json({ code: 0, data: { ok: true, info } } satisfies ApiResponse);
    });

    /** GET /api/channels/settings — 渠道配置段（启用开关 / 技能白名单 / 动态插件）。 */
    channels.get('/api/channels/settings', (c) => {
        return c.json({ code: 0, data: getChannelsSettings() } satisfies ApiResponse);
    });

    /** PUT /api/channels/settings — 更新渠道配置（改动需重启后端重新注册渠道方生效）。 */
    channels.put('/api/channels/settings', async (c) => {
        const patch = (await c.req.json().catch(() => ({}))) as ChannelsSettings;
        const merged = updateChannelsSettings(patch);
        return c.json({ code: 0, data: merged } satisfies ApiResponse);
    });

    /** GET /api/channels/events — SSE：渠道消息事件实时推送。 */
    channels.get('/api/channels/events', (c) => {
        return streamSSE(c, async (stream) => {
            const unsubscribe = channelEvents.subscribe((event) => {
                void stream.writeSSE({ event: 'channel', data: JSON.stringify(event) });
            });
            stream.onAbort(() => unsubscribe());
            log.info('渠道事件 SSE 已连接');
            try {
                while (!c.req.raw.signal.aborted) {
                    await stream.sleep(SSE_PING_MS);
                    await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
                }
            } finally {
                unsubscribe();
            }
        });
    });

    return channels;
}
