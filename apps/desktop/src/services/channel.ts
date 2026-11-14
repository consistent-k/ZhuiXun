import request, { API_BASE_URL, authHeaders, type BaseResponse } from '@/utils/request';

/** 渠道运行时状态 */
export type ChannelStatus = 'idle' | 'starting' | 'running' | 'error';

/** 渠道列表项（GET /api/channels） */
export interface ChannelItem {
    id: string;
    name: string;
    status: ChannelStatus;
    configured: boolean;
    running: boolean;
    uptimeMs: number;
    info: string[];
    /** 是否支持表单绑定（Telegram/微信） */
    supportsBind: boolean;
    /** 是否支持扫码绑定（预留） */
    supportsQr: boolean;
}

/** 渠道消息事件（SSE /api/channels/events） */
export interface ChannelMessageEvent {
    type: 'inbound' | 'reply' | 'error';
    channelId: string;
    channelName: string;
    userId: string;
    sessionId: string;
    text: string;
    ts: number;
}

/** 渠道配置段：所有渠道均为插件，plugins 为允许加载的插件 id 列表 */
export interface ChannelsSettings {
    plugins?: string[];
}

/** 渠道列表 + 运行状态 */
export function fetchChannelsApi(): Promise<BaseResponse<ChannelItem[]>> {
    return request.get('/api/channels');
}

/** 启动渠道监听 */
export function startChannelApi(id: string): Promise<BaseResponse<{ ok: boolean; status: ChannelStatus }>> {
    return request.post(`/api/channels/${encodeURIComponent(id)}/start`);
}

/** 停止渠道监听 */
export function stopChannelApi(id: string): Promise<BaseResponse<{ ok: boolean }>> {
    return request.post(`/api/channels/${encodeURIComponent(id)}/stop`);
}

/** 表单绑定（Telegram: {token}；微信: {baseUrl, token}） */
export function bindChannelApi(
    id: string,
    payload: Record<string, string>
): Promise<BaseResponse<{ ok: boolean; info: string[] }>> {
    return request.post(`/api/channels/${encodeURIComponent(id)}/bind`, { data: payload });
}

/** 解绑渠道 */
export function unbindChannelApi(id: string): Promise<BaseResponse<{ ok: boolean; info: string[] }>> {
    return request.post(`/api/channels/${encodeURIComponent(id)}/unbind`);
}

/** 扫码发起结果 */
export interface QrStartResult {
    sessionKey: string;
    qrcodeUrl?: string;
    message: string;
}

/** 扫码轮询结果 */
export interface QrStatusResult {
    connected: boolean;
    accountId?: string;
    message: string;
}

/** 发起扫码绑定（微信），返回二维码内容供前端渲染二维码图 */
export function startChannelQrApi(id: string): Promise<BaseResponse<QrStartResult>> {
    return request.post(`/api/channels/${encodeURIComponent(id)}/bind/qr`);
}

/** 轮询扫码结果（长轮询，单次；前端反复调用直到 connected 或过期） */
export function pollChannelQrApi(id: string, sessionKey: string): Promise<BaseResponse<QrStatusResult>> {
    return request.get(`/api/channels/${encodeURIComponent(id)}/bind/status`, {
        params: { sessionKey },
        hideError: true
    });
}

/** 读取渠道配置段 */
export function fetchChannelsSettingsApi(): Promise<BaseResponse<ChannelsSettings>> {
    return request.get('/api/channels/settings');
}

/** 更新渠道配置段（改动需重启后端重新注册渠道方生效） */
export function updateChannelsSettingsApi(patch: ChannelsSettings): Promise<BaseResponse<ChannelsSettings>> {
    return request.put('/api/channels/settings', { data: patch });
}

/**
 * 订阅渠道消息事件 SSE。返回取消订阅函数。
 *
 * 默认用原生 `EventSource`：它是浏览器/WebView 原生 SSE 通道、逐条下发且自带重连，
 * 优于手动实现的 fetch 流解析。仅当配置了 auth token 时回退到 fetch（EventSource 无法附带自定义鉴权头）。
 */
export function subscribeChannelEvents(
    onEvent: (event: ChannelMessageEvent) => void,
    onError?: (err: unknown) => void
): () => void {
    const url = `${API_BASE_URL}/api/channels/events`;
    const hasAuthToken = Object.keys(authHeaders()).length > 0;

    if (!hasAuthToken && typeof EventSource !== 'undefined') {
        const es = new EventSource(url);
        const handler = (e: MessageEvent) => {
            try {
                onEvent(JSON.parse(e.data) as ChannelMessageEvent);
            } catch {
                /* 忽略解析失败 */
            }
        };
        es.addEventListener('channel', handler as EventListener);
        // EventSource 自带重连，瞬时错误不冒泡给上层的重连逻辑，避免重复建连
        es.onerror = () => {};
        return () => es.close();
    }

    // token 模式回退：fetch + ReadableStream 手动解析 SSE（可带鉴权头）
    const controller = new AbortController();
    void (async () => {
        try {
            const resp = await fetch(url, {
                headers: { Accept: 'text/event-stream', ...authHeaders() },
                signal: controller.signal
            });
            if (!resp.body) return;
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const records = buffer.split('\n\n');
                buffer = records.pop() ?? '';
                for (const record of records) {
                    let eventName = 'message';
                    let data = '';
                    for (const line of record.split('\n')) {
                        if (line.startsWith('event:')) eventName = line.slice(6).trim();
                        else if (line.startsWith('data:')) data += line.slice(5).trim();
                    }
                    if (eventName !== 'channel' || !data) continue;
                    try {
                        onEvent(JSON.parse(data) as ChannelMessageEvent);
                    } catch {
                        /* 忽略解析失败 */
                    }
                }
            }
        } catch (err) {
            if (!controller.signal.aborted) onError?.(err);
        }
    })();

    return () => controller.abort();
}
