import { Hono } from 'hono';
import { z } from 'zod';

import { fail, ok } from '@/http/respond';
import { BUILTIN_COMMANDS, CommandError, expandCommandText, getCommandStore } from '@/modules/commands';

const upsertSchema = z.object({
    description: z.string().max(500).optional(),
    argumentHint: z.string().max(500).optional(),
    body: z.string().min(1).max(20_000)
});
const expandSchema = z.object({ text: z.string().max(100_000) });

/**
 * slash 命令 REST：用户命令 CRUD（`~/.zhuixun/commands/<name>.md`）+ 发送前展开。
 * 内置命令（/new /help /compact）由前端本地处理，列表里单独给出以便联想。
 */
export function createCommandsRouter() {
    const router = new Hono();

    router.get('/api/commands', async (c) =>
        ok(c, { builtin: BUILTIN_COMMANDS, user: await getCommandStore().list() })
    );

    // 静态路径 expand 必须先于 :name 注册
    router.post('/api/commands/expand', async (c) => {
        const parsed = expandSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return fail(c, 400, '请求参数不合法');
        return ok(c, await expandCommandText(parsed.data.text, (name) => getCommandStore().bodyOf(name)));
    });

    router.get('/api/commands/:name', async (c) => {
        const detail = await getCommandStore().get(c.req.param('name'));
        return detail ? ok(c, detail) : fail(c, 404, '命令不存在');
    });

    router.put('/api/commands/:name', async (c) => {
        const parsed = upsertSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return fail(c, 400, '请求参数不合法');
        try {
            return ok(c, await getCommandStore().save(c.req.param('name'), parsed.data));
        } catch (error) {
            if (error instanceof CommandError) return fail(c, error.status, error.message);
            throw error;
        }
    });

    router.delete('/api/commands/:name', async (c) => {
        const name = c.req.param('name');
        try {
            await getCommandStore().delete(name);
        } catch (error) {
            if (error instanceof CommandError) return fail(c, error.status, error.message);
            throw error;
        }
        return ok(c, { name });
    });

    return router;
}
