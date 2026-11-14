import type { JobView } from '@/types/job';
import type { SessionEvent } from '@/types/session';
import request, { API_BASE_URL, authHeaders, type BaseResponse } from '@/utils/request';

/** 后台任务列表 */
export function fetchJobsApi(): Promise<BaseResponse<JobView[]>> {
    return request.get('/api/jobs');
}

/** 取消后台任务 */
export function cancelJobApi(id: string): Promise<BaseResponse<JobView>> {
    return request.post(`/api/jobs/${encodeURIComponent(id)}/cancel`);
}

/**
 * 订阅会话运行事件 SSE（后台完成唤醒 / 自驱轮次 / Job 状态）。
 * 与自动化事件 SSE 同构：默认 EventSource，配置了 auth token 时回退 fetch 流解析。事件名固定 `session`。
 */
export function subscribeSessionEvents(
    onEvent: (event: SessionEvent) => void,
    onError?: (err: unknown) => void
): () => void {
    const url = `${API_BASE_URL}/api/session/events`;
    const hasAuthToken = Object.keys(authHeaders()).length > 0;

    if (!hasAuthToken && typeof EventSource !== 'undefined') {
        const es = new EventSource(url);
        const handler = (e: MessageEvent) => {
            try {
                onEvent(JSON.parse(e.data) as SessionEvent);
            } catch {
                /* 忽略解析失败 */
            }
        };
        es.addEventListener('session', handler as EventListener);
        es.onerror = () => {};
        return () => es.close();
    }

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
                    if (eventName !== 'session' || !data) continue;
                    try {
                        onEvent(JSON.parse(data) as SessionEvent);
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
