import { API_BASE_URL, authHeaders } from '@/utils/request';

/** 后端 /health 响应体（非 `{ code, data }` 信封，故不走统一 request 封装，用原生 fetch） */
export interface HealthStatus {
    status: 'ok' | 'degraded' | 'unavailable';
    ready: boolean;
    mcp: string;
    mcpError?: string;
    skills: number;
    /** 是否处于危险跳过审批模式（--dangerously-skip-permissions） */
    dangerSkipPermissions: boolean;
    startedAt?: string;
    timestamp: number;
}

/**
 * 拉取后端健康状态。
 *
 * /health 直接返回裸对象（无 `{ code, data }` 信封）且不在 apiGuard 之后，故绕开统一 request
 * 封装、用原生 fetch（authHeaders 正是为「不走 request 的原生 fetch」预留的复用点）。
 * 任何失败一律返回 null——调用方据此降级为「不显示危险提示」，宁可漏提示也不误报安全状态。
 */
export async function fetchHealthApi(): Promise<HealthStatus | null> {
    try {
        const res = await fetch(`${API_BASE_URL}/health`, { headers: authHeaders() });
        return (await res.json()) as HealthStatus;
    } catch {
        return null;
    }
}
