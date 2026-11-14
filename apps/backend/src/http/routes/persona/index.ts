import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { ApiResponse } from '@/config/types';
import {
    createPersona,
    deletePersona,
    listPersonas,
    PersonaError,
    setDefaultPersona,
    updatePersona
} from '@/modules/persona';
import { getLogger } from '@/platform/logging/index';

const createSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    instruction: z.string()
});

const updateSchema = createSchema.partial();

const defaultSchema = z.object({
    defaultId: z.string().min(1)
});

function fail(c: Context, error: unknown) {
    if (error instanceof PersonaError) {
        return c.json({ code: error.status, message: error.message } satisfies ApiResponse, error.status);
    }
    getLogger('Persona').error('风格配置操作失败', { err: error });
    return c.json({ code: 500, message: '风格配置操作失败，请查看后端日志' } satisfies ApiResponse, 500);
}

/** 风格配置 REST：设置页默认选择与自定义风格 CRUD。 */
export function createPersonaRouter() {
    const router = new Hono();

    router.get('/api/personas', (c) => {
        return c.json({ code: 0, data: listPersonas() } satisfies ApiResponse);
    });

    router.post('/api/personas', async (c) => {
        const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ code: 400, message: '请求参数不合法' } satisfies ApiResponse, 400);
        try {
            return c.json({ code: 0, data: createPersona(parsed.data) } satisfies ApiResponse);
        } catch (error) {
            return fail(c, error);
        }
    });

    // 静态路径必须先于 /:id 注册，避免 default 被参数路由捕获。
    router.put('/api/personas/default', async (c) => {
        const parsed = defaultSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ code: 400, message: '请求参数不合法' } satisfies ApiResponse, 400);
        try {
            return c.json({ code: 0, data: setDefaultPersona(parsed.data.defaultId) } satisfies ApiResponse);
        } catch (error) {
            return fail(c, error);
        }
    });

    router.put('/api/personas/:id', async (c) => {
        const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ code: 400, message: '请求参数不合法' } satisfies ApiResponse, 400);
        try {
            return c.json({ code: 0, data: updatePersona(c.req.param('id'), parsed.data) } satisfies ApiResponse);
        } catch (error) {
            return fail(c, error);
        }
    });

    router.delete('/api/personas/:id', (c) => {
        try {
            return c.json({ code: 0, data: deletePersona(c.req.param('id')) } satisfies ApiResponse);
        } catch (error) {
            return fail(c, error);
        }
    });

    return router;
}
