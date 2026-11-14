import { Hono } from 'hono';

import { fail, ok } from '@/http/respond';
import { getGoalService } from '@/modules/goal/registry';

/**
 * 自驱循环路由（薄路由）：查询状态 / 手动解除。
 * 开启走会话内 `GoalArm` 工具（需要模型判断是否值得自驱）；前端只负责展示与「停止」。
 */
export function createGoalRouter(): Hono {
    const router = new Hono();

    /** GET /api/goal?sessionId=xxx — 取某会话自驱状态；不带 sessionId 返回全部。 */
    router.get('/api/goal', (c) => {
        const service = getGoalService();
        const sessionId = c.req.query('sessionId');
        if (!sessionId) return ok(c, service.list());
        return ok(c, service.get(sessionId));
    });

    /** POST /api/goal/:sessionId/disarm — 前端「停止自驱」。 */
    router.post('/api/goal/:sessionId/disarm', (c) => {
        const view = getGoalService().disarm(c.req.param('sessionId'));
        return view ? ok(c, view) : fail(c, 404, '该会话没有自驱循环');
    });

    return router;
}
