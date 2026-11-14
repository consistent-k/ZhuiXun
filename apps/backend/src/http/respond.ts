import type { Context } from 'hono';

import type { ApiResponse } from '@/config/types';

/**
 * 统一响应信封。
 *
 * 改造前 `c.json({ code, message, data })` 在各路由手写约 209 处，状态码与 code 是否对齐、
 * 字段拼写全靠自觉。这里收成三个 helper；保留三个刻意例外（见文件末尾注释）。
 */

/** 成功：`{ code: 0, data }`。 */
export function ok<T>(c: Context, data: T): Response {
    const body: ApiResponse<T> = { code: 0, data };
    return c.json(body);
}

/**
 * 失败：默认 HTTP 状态与业务 code 相同。
 * 业务上「结果放在 data、code 仍为 0」的场景（表单校验、连通性测试）不要用本函数。
 */
export function fail(c: Context, code: number, message: string, status: number = code): Response {
    const body: ApiResponse = { code, message };
    return c.json(body, status as 400);
}

/** 服务尚未就绪（MCP/技能注册表初始化中）：固定 503。 */
export function notReady(c: Context, message = '服务尚未就绪'): Response {
    return fail(c, 503, message);
}

/**
 * 刻意保留的例外（不要迁移到本文件）：
 * - `GET /health` 返回裸状态体 `{ status, ... }`，是给探活/监控消费的，不套信封。
 * - SSE 流与附件/导出等端点返回原始 body，不是 JSON。
 * - `POST /api/settings/providers/:name/test` 与 `POST /api/projects/validate-path`
 *   把「校验未通过」表达为 `code: 0, data: { ok: false }`，前端按 data 分支处理。
 */
