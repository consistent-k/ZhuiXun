import { Hono } from 'hono';

import type { RuntimeStatus } from '@/platform/runtime-status';

/**
 * 健康检查。依赖由组合根注入（`() => container?.runtime`），不再从 root import 全局可变状态。
 * 服务未初始化完成时 getter 返回 undefined，按「不可用」处理。
 */
/** 健康检查附加的安全态势（权限基线来源、hooks 状态等），由组合根注入，缺省不透出。 */
export type HealthExtras = () => Promise<Record<string, unknown>>;

export function createHealthRouter(getRuntime: () => RuntimeStatus | undefined, getExtras?: HealthExtras): Hono {
    const health = new Hono();

    health.get('/health', async (c) => {
        const runtime = getRuntime();

        // 未就绪 = 服务不可用，返回 503 让监控能告警
        if (!runtime?.ready) {
            return c.json(
                {
                    status: 'unavailable',
                    ready: false,
                    mcp: runtime?.mcp ?? 'unknown',
                    mcpError: runtime?.mcpError,
                    skills: runtime?.skills ?? 0,
                    dangerSkipPermissions: runtime?.dangerSkipPermissions ?? false,
                    timestamp: Date.now()
                },
                503
            );
        }

        // 已就绪但 MCP 异常 = 降级运行，仍返回 200，但状态里如实反映
        const degraded = runtime.mcp === 'degraded' || runtime.mcp === 'failed';
        // 附加信息只用于展示，读取失败不影响探活结论
        const extras = getExtras ? await getExtras().catch(() => ({})) : {};

        return c.json(
            {
                status: degraded ? 'degraded' : 'ok',
                ready: true,
                mcp: runtime.mcp,
                mcpError: runtime.mcpError,
                skills: runtime.skills,
                dangerSkipPermissions: runtime.dangerSkipPermissions,
                ...extras,
                startedAt: runtime.startedAt,
                instanceId: runtime.instanceId,
                timestamp: Date.now()
            },
            200
        );
    });

    return health;
}
