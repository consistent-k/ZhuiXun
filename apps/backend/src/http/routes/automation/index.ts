import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { fail, ok } from '@/http/respond';
import { automationEvents, getAutomationService, type AutomationListFilter } from '@/modules/automation';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('AutomationRoute');

/** SSE 保活心跳间隔。 */
const SSE_PING_MS = 25_000;

/** 把业务异常映射为 400（校验类错误），其余交给全局 errorHandler。 */
function toBadRequest(c: Parameters<typeof fail>[0], error: unknown): Response {
    const message = error instanceof Error ? error.message : String(error);
    return fail(c, 400, message);
}

/**
 * 自动化任务路由（薄路由）：CRUD + 启停 + 立即运行 + 运行历史 + 事件 SSE。
 * 业务编排在 modules/automation 的 AutomationService；本层只做入参读取与信封包装。
 */
export function createAutomationRouter(): Hono {
    const router = new Hono();
    const service = getAutomationService();

    /** GET /api/automation?status=enabled|inactive|all — 列表。 */
    router.get('/api/automation', async (c) => {
        const status = (c.req.query('status') as AutomationListFilter) || 'all';
        const list = await service.list(status);
        return ok(c, list);
    });

    /** POST /api/automation — 创建。 */
    router.post('/api/automation', async (c) => {
        try {
            const body = await c.req.json();
            const view = await service.create(body);
            return ok(c, view);
        } catch (error) {
            return toBadRequest(c, error);
        }
    });

    // PLACEHOLDER_ROUTES

    /** PUT /api/automation/:id — 编辑。 */
    router.put('/api/automation/:id', async (c) => {
        try {
            const body = await c.req.json();
            const view = await service.update(c.req.param('id'), body);
            return ok(c, view);
        } catch (error) {
            return toBadRequest(c, error);
        }
    });

    /** PUT /api/automation/:id/enabled — 启停。 */
    router.put('/api/automation/:id/enabled', async (c) => {
        try {
            const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
            const view = await service.setEnabled(c.req.param('id'), body.enabled === true);
            return ok(c, view);
        } catch (error) {
            return toBadRequest(c, error);
        }
    });

    /** POST /api/automation/:id/run — 立即运行。 */
    router.post('/api/automation/:id/run', async (c) => {
        try {
            const runId = await service.runNow(c.req.param('id'));
            return ok(c, { runId });
        } catch (error) {
            return toBadRequest(c, error);
        }
    });

    /** GET /api/automation/:id/runs?page&pageSize — 运行历史（分页，台账有界 ≤50）。 */
    router.get('/api/automation/:id/runs', async (c) => {
        const all = await service.listRuns(c.req.param('id'));
        const page = Math.max(1, Number(c.req.query('page')) || 1);
        const pageSize = Math.max(1, Number(c.req.query('pageSize')) || 20);
        const start = (page - 1) * pageSize;
        return ok(c, { runs: all.slice(start, start + pageSize), total: all.length });
    });

    /** DELETE /api/automation/:id — 删除。 */
    router.delete('/api/automation/:id', async (c) => {
        await service.delete(c.req.param('id'));
        return ok(c, { ok: true });
    });

    /** GET /api/automation/events — SSE：调度/结算/变更实时推送。 */
    router.get('/api/automation/events', (c) => {
        return streamSSE(c, async (stream) => {
            const unsubscribe = automationEvents.subscribe((event) => {
                void stream.writeSSE({ event: 'automation', data: JSON.stringify(event) });
            });
            stream.onAbort(() => unsubscribe());
            log.info('自动化任务事件 SSE 已连接');
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

    return router;
}
