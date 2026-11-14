import { Hono } from 'hono';

import { fail, ok } from '@/http/respond';
import { getJobService } from '@/modules/jobs';

/** 把业务异常映射为 400，其余交给全局 errorHandler。 */
function toBadRequest(c: Parameters<typeof fail>[0], error: unknown): Response {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
}

/**
 * 后台任务路由（薄路由）：列表 / 详情 / 取消。
 * 创建走会话内 `JobStart` 工具；状态变化经 `/api/session/events` 推送。
 */
export function createJobsRouter(): Hono {
    const router = new Hono();

    router.get('/api/jobs', async (c) => ok(c, await getJobService().list()));

    router.get('/api/jobs/:id', async (c) => {
        const job = await getJobService().get(c.req.param('id'));
        return job ? ok(c, job) : fail(c, 404, `后台任务 ${c.req.param('id')} 不存在`);
    });

    router.post('/api/jobs/:id/cancel', async (c) => {
        try {
            const job = await getJobService().cancel(c.req.param('id'));
            return job ? ok(c, job) : fail(c, 404, `后台任务 ${c.req.param('id')} 不存在或已结束`);
        } catch (error) {
            return toBadRequest(c, error);
        }
    });

    return router;
}
