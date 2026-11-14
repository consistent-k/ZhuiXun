import { setTimeout } from 'node:timers/promises';

import qr from 'qrcode-terminal';

import type { Api } from './client';

export interface Channel {
    id: string;
    name: string;
    configured: boolean;
    running: boolean;
    supportsQr: boolean;
    supportsBind: boolean;
    status: string;
}

const route = '/api/channels';

export async function channelCommand(api: Api, action = 'status', id?: string, signal?: AbortSignal): Promise<string> {
    const channels = await api.request<Channel[]>(route);
    if (action === 'status') {
        return channels.map((channel) => `${channel.id}  ${channel.status}`).join('\n') || '没有已注册的渠道插件';
    }
    if (action === 'stop' && id === 'all') {
        const results = await Promise.allSettled(
            channels
                .filter((channel) => channel.running)
                .map(async (channel) => {
                    try {
                        await api.post(`${route}/${encodeURIComponent(channel.id)}/stop`);
                        return `${channel.id} 已停止`;
                    } catch (error) {
                        throw new Error(`${channel.id}: ${String(error)}`, { cause: error });
                    }
                })
        );
        return (
            results
                .map((result) => (result.status === 'fulfilled' ? result.value : String(result.reason)))
                .join('\n') || '没有正在运行的渠道'
        );
    }
    const channel = channels.find((item) => item.id === id);
    if (!channel) throw new Error('请指定已注册的渠道 ID');
    const base = `${route}/${encodeURIComponent(channel.id)}`;
    if (action === 'start' || action === 'stop') {
        await api.post(`${base}/${action}`);
        return `${channel.name} ${action === 'start' ? '已启动' : '已停止'}`;
    }
    if (action === 'logout') {
        const result = await api.post<{ info: string[] }>(`${base}/unbind`);
        return result.info.join('\n');
    }
    if (action === 'login' && channel.supportsQr) {
        const started = await api.post<{ qrcodeUrl?: string; sessionKey: string; message: string }>(
            `${base}/bind/qr`,
            undefined,
            signal
        );
        if (!started.qrcodeUrl || !started.sessionKey) return started.message;
        const code = await new Promise<string>((resolve) => qr.generate(started.qrcodeUrl!, { small: true }, resolve));
        process.stdout.write(`${code}\n${started.message}\n`);
        const pollSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
            : AbortSignal.timeout(180_000);
        for (;;) {
            const result = await api.request<{ connected: boolean; message: string }>(
                `${base}/bind/status?sessionKey=${encodeURIComponent(started.sessionKey)}`,
                { signal: pollSignal }
            );
            if (result.connected || /过期|失败|已绑定|验证码|无效/.test(result.message)) return result.message;
            await setTimeout(1000, undefined, { signal: pollSignal });
        }
    }
    throw new Error('用法：/channel status|start|stop|login|logout [id]');
}

export async function bindTelegram(api: Api, token: string): Promise<string> {
    const result = await api.post<{ ok: boolean; info: string[] }>(`${route}/telegram/bind`, { token });
    return result.info.join('\n') || (result.ok ? '绑定成功' : '绑定失败');
}
