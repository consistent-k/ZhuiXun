import { Hono } from 'hono';
import { z } from 'zod';

import { fail, ok } from '@/http/respond';
import { hooksView, HooksTrustError, readHookAudit, updateHooksTrust } from '@/modules/hooks';

const trustSchema = z
    .object({
        hash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        enabled: z.boolean().optional()
    })
    .refine((v) => v.hash !== undefined || v.enabled !== undefined, { error: 'hash 与 enabled 至少传一个' });

/**
 * Hooks REST：hooks.json 仅手工编辑，这里只读展示、信任当前 hash、切换总开关与查看执行记录。
 */
export function createHooksRouter() {
    const router = new Hono();

    router.get('/api/hooks', (c) => ok(c, hooksView()));

    // 信任当前配置 / 切换总开关；hash 与此刻文件不一致返回 409（防审阅后被替换）
    router.put('/api/hooks/trust', async (c) => {
        const parsed = trustSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return fail(c, 400, '请求参数不合法');
        try {
            return ok(c, updateHooksTrust(parsed.data));
        } catch (error) {
            if (error instanceof HooksTrustError) return fail(c, 409, error.message);
            throw error;
        }
    });

    router.get('/api/hooks/audit', async (c) => {
        const raw = Number(c.req.query('limit') ?? 50);
        const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : 50;
        return ok(c, await readHookAudit(limit));
    });

    return router;
}
