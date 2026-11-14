import type { PolicyEvaluateResult } from '@zhuixun/shared';
import { Hono } from 'hono';
import { z } from 'zod';

import { WORKSPACE_DIR } from '@/config/shell';
import { fail, ok } from '@/http/respond';
import {
    getPermissionStore,
    getPolicyEngine,
    normalizeRuleSet,
    parsePermissionRule,
    type RememberInput
} from '@/modules/permission';

const ruleList = z.array(z.string()).max(200);
const ruleSetSchema = z.object({ deny: ruleList, ask: ruleList, allow: ruleList });
const evaluateSchema = z.object({
    rule: z.string().max(500).optional(),
    toolName: z.string().min(1).max(200).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    cwd: z.string().max(4096).optional(),
    /** 试算对象是否为 MCP 工具（运行时才知道，试算由调用方声明） */
    mcp: z.boolean().optional()
});

/**
 * 命令审批权限 REST：供设置页「命令授权」面板与前端审批卡读写。
 * 响应统一 `{ code, data, message }`，成功码 0。规则真源在后端（永久落盘 + 会话内存）。
 */
export function createPermissionRouter() {
    const router = new Hono();

    // 读取永久规则 + 总开关
    router.get('/api/permissions', async (c) => {
        const data = await getPermissionStore().get();
        return c.json({ code: 0, data });
    });

    // 记住一条命令（Bash）或写入目录（Write）：永久或本次会话
    router.post('/api/permissions', async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            tool?: unknown;
            command?: unknown;
            filePath?: unknown;
            scope?: unknown;
            sessionId?: unknown;
        } | null;
        if (!body || (body.scope !== 'permanent' && body.scope !== 'session')) {
            return c.json({ code: 400, message: '请求参数不合法' }, 400);
        }
        const tool = body.tool === 'Write' ? 'Write' : 'Bash';
        if (tool === 'Bash' && typeof body.command !== 'string') {
            return c.json({ code: 400, message: '请求参数不合法' }, 400);
        }
        if (tool === 'Write' && typeof body.filePath !== 'string') {
            return c.json({ code: 400, message: '请求参数不合法' }, 400);
        }
        const input: RememberInput = {
            tool,
            command: typeof body.command === 'string' ? body.command : undefined,
            filePath: typeof body.filePath === 'string' ? body.filePath : undefined,
            scope: body.scope,
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined
        };
        const data = await getPermissionStore().remember(input);
        return c.json({ code: 0, data });
    });

    // 删除一条永久规则
    router.delete('/api/permissions/:id', async (c) => {
        const id = c.req.param('id');
        await getPermissionStore().deleteRule(id);
        return c.json({ code: 0, data: { id } });
    });

    // 切换自动放行总开关：开关是「设置」而非 permissions 集合本身，
    // 故独立成子资源 /api/permissions/auto-approval，避免与 POST（新增规则）共用集合 URI 造成语义重载。
    router.put('/api/permissions/auto-approval', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
        if (!body || typeof body.enabled !== 'boolean') {
            return c.json({ code: 400, message: '请求参数不合法' }, 400);
        }
        const data = await getPermissionStore().setAutoApproval(body.enabled);
        return c.json({ code: 0, data });
    });

    // 声明式策略：团队基线（只读）+ 用户规则 + 被跳过的非法规则
    router.get('/api/permissions/rules', async (c) => ok(c, await getPolicyEngine().view()));

    // 整段覆盖写用户规则：逐条校验，任一非法即 400（不落盘半份规则）
    router.put('/api/permissions/rules', async (c) => {
        const parsed = ruleSetSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return fail(c, 400, '请求参数不合法');
        let rules;
        try {
            rules = normalizeRuleSet(parsed.data);
        } catch (error) {
            return fail(c, 400, error instanceof Error ? error.message : '规则不合法');
        }
        await getPermissionStore().setRules(rules);
        return ok(c, await getPolicyEngine().view());
    });

    // 规则格式校验 + 按当前策略试算（只判定，不执行、不写审计）
    router.post('/api/permissions/rules/evaluate', async (c) => {
        const parsed = evaluateSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return fail(c, 400, '请求参数不合法');
        const { rule, toolName, input, cwd, mcp } = parsed.data;
        const result: PolicyEvaluateResult = { valid: true };
        if (rule !== undefined) {
            try {
                parsePermissionRule(rule);
            } catch (error) {
                result.valid = false;
                result.error = error instanceof Error ? error.message : '规则不合法';
            }
        }
        if (toolName) {
            // 与对话一致：未指定工作目录时按临时工作区解析相对路径
            result.decision = await getPolicyEngine().evaluate(toolName, input ?? {}, {
                cwd: cwd || WORKSPACE_DIR,
                isMcpTool: () => mcp === true
            });
        }
        return ok(c, result);
    });

    return router;
}
