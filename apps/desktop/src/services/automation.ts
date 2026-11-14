import type {
    AutomationCreateRequest,
    AutomationEvent,
    AutomationFilter,
    AutomationRunsPage,
    AutomationUpdateRequest,
    AutomationView
} from '@/types/automation';
import request, { API_BASE_URL, authHeaders, type BaseResponse } from '@/utils/request';

/** 任务列表（可按启用/停用/全部筛选） */
export function fetchAutomationsApi(status: AutomationFilter = 'all'): Promise<BaseResponse<AutomationView[]>> {
    return request.get('/api/automation', { params: { status } });
}

/** 创建任务 */
export function createAutomationApi(payload: AutomationCreateRequest): Promise<BaseResponse<AutomationView>> {
    return request.post('/api/automation', { data: payload });
}

/** 编辑任务 */
export function updateAutomationApi(
    id: string,
    payload: AutomationUpdateRequest
): Promise<BaseResponse<AutomationView>> {
    return request.put(`/api/automation/${encodeURIComponent(id)}`, { data: payload });
}

/** 删除任务 */
export function deleteAutomationApi(id: string): Promise<BaseResponse<{ ok: boolean }>> {
    return request.delete(`/api/automation/${encodeURIComponent(id)}`);
}

/** 启停任务 */
export function setAutomationEnabledApi(id: string, enabled: boolean): Promise<BaseResponse<AutomationView>> {
    return request.put(`/api/automation/${encodeURIComponent(id)}/enabled`, { data: { enabled } });
}

/** 立即运行一次（Run Now） */
export function runAutomationApi(id: string): Promise<BaseResponse<{ runId: string }>> {
    return request.post(`/api/automation/${encodeURIComponent(id)}/run`);
}

/** 运行历史（分页） */
export function fetchAutomationRunsApi(
    id: string,
    params: { page?: number; pageSize?: number } = {}
): Promise<BaseResponse<AutomationRunsPage>> {
    return request.get(`/api/automation/${encodeURIComponent(id)}/runs`, { params });
}

/**
 * 订阅自动化任务事件 SSE。返回取消订阅函数。
 *
 * 与渠道事件 SSE 同款：默认走原生 EventSource（自带重连），仅在配置了 auth token 时回退 fetch
 * 流解析（EventSource 无法附带自定义鉴权头）。事件名固定 `automation`，data 为 AutomationEvent JSON。
 */
export function subscribeAutomationEvents(
    onEvent: (event: AutomationEvent) => void,
    onError?: (err: unknown) => void
): () => void {
    const url = `${API_BASE_URL}/api/automation/events`;
    const hasAuthToken = Object.keys(authHeaders()).length > 0;

    if (!hasAuthToken && typeof EventSource !== 'undefined') {
        const es = new EventSource(url);
        const handler = (e: MessageEvent) => {
            try {
                onEvent(JSON.parse(e.data) as AutomationEvent);
            } catch {
                /* 忽略解析失败 */
            }
        };
        es.addEventListener('automation', handler as EventListener);
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
                    if (eventName !== 'automation' || !data) continue;
                    try {
                        onEvent(JSON.parse(data) as AutomationEvent);
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
