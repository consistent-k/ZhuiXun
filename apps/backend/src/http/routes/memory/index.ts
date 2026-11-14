import fs from 'node:fs/promises';

import { Hono } from 'hono';

import { getMemorySettings, updateMemorySettings } from '@/config/settings-store';
import { readIndex } from '@/modules/memory';
import { runMemoryDream } from '@/modules/memory';
import { projectsMemoryParent, resolveMemoryRoot } from '@/modules/memory';
import { getMemoryStore } from '@/modules/memory';
import { isMemoryScope, isMemoryType, type MemoryScope } from '@/modules/memory';
import { getProjectStore } from '@/modules/projects';

/**
 * 记忆管理 REST：供设置页「记忆管理」面板读写。
 * 双层（global / project）类型化多文件记忆；响应统一 `{ code, data, message }`，成功码 0。
 * 记忆真源在后端 Markdown 文件，模型侧通过 memory-tools 读写同一 store。
 */
export function createMemoryRouter() {
    const router = new Hono();

    const parseScope = (scope: unknown, projectId: unknown): { scope: MemoryScope; projectId?: string } => {
        const s: MemoryScope = isMemoryScope(scope) ? scope : 'global';
        const pid = typeof projectId === 'string' && projectId ? projectId : undefined;
        return s === 'project' && pid ? { scope: 'project', projectId: pid } : { scope: 'global' };
    };

    const storeOf = (scope: MemoryScope, projectId?: string) => getMemoryStore(resolveMemoryRoot(scope, projectId));

    // 某层总览：开关（含自动沉淀/整理）+ 索引 + 条目清单
    router.get('/api/memory', async (c) => {
        const { scope, projectId } = parseScope(c.req.query('scope'), c.req.query('projectId'));
        const mem = getMemorySettings();
        const [index, items] = await Promise.all([
            readIndex(resolveMemoryRoot(scope, projectId)),
            storeOf(scope, projectId).list()
        ]);
        return c.json({ code: 0, data: { ...mem, scope, projectId, index, items } });
    });

    // 部分更新：开关 / 自动沉淀 / 自动整理（全局）+ 整体改某层索引
    router.patch('/api/memory', async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            enabled?: unknown;
            autoExtract?: unknown;
            autoDream?: unknown;
            scope?: unknown;
            projectId?: unknown;
            index?: unknown;
        } | null;
        if (!body || typeof body !== 'object') {
            return c.json({ code: 400, message: '请求参数不合法' }, 400);
        }
        const patch: { enabled?: boolean; autoExtract?: boolean; autoDream?: boolean } = {};
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (typeof body.autoExtract === 'boolean') patch.autoExtract = body.autoExtract;
        if (typeof body.autoDream === 'boolean') patch.autoDream = body.autoDream;
        if (Object.keys(patch).length > 0) updateMemorySettings(patch);
        if (typeof body.index === 'string') {
            const target = parseScope(body.scope, body.projectId);
            await storeOf(target.scope, target.projectId).writeIndex(body.index);
        }
        const { scope, projectId } = parseScope(body.scope, body.projectId);
        const [index, items] = await Promise.all([
            readIndex(resolveMemoryRoot(scope, projectId)),
            storeOf(scope, projectId).list()
        ]);
        return c.json({ code: 0, data: { ...getMemorySettings(), scope, projectId, index, items } });
    });

    // 读单条
    router.get('/api/memory/item', async (c) => {
        const { scope, projectId } = parseScope(c.req.query('scope'), c.req.query('projectId'));
        const name = c.req.query('name') ?? '';
        const record = await storeOf(scope, projectId).read(name);
        if (!record) return c.json({ code: 404, message: '记忆不存在' }, 404);
        return c.json({ code: 0, data: record });
    });

    // 新建/覆盖单条
    router.put('/api/memory/item', async (c) => {
        const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body.name !== 'string' || !isMemoryType(body.type)) {
            return c.json({ code: 400, message: '缺少 name 或 type 非法' }, 400);
        }
        const { scope, projectId } = parseScope(body.scope, body.projectId);
        try {
            const { record } = await storeOf(scope, projectId).write({
                name: body.name,
                type: body.type,
                description: typeof body.description === 'string' ? body.description : '',
                content: typeof body.content === 'string' ? body.content : ''
            });
            return c.json({ code: 0, data: record });
        } catch (err) {
            return c.json({ code: 400, message: err instanceof Error ? err.message : '写入失败' }, 400);
        }
    });

    // 删单条
    router.delete('/api/memory/item', async (c) => {
        const { scope, projectId } = parseScope(c.req.query('scope'), c.req.query('projectId'));
        const ok = await storeOf(scope, projectId).delete(c.req.query('name') ?? '');
        return c.json({ code: 0, data: { ok } });
    });

    // 列出有项目层记忆的项目（设置页切层下拉）
    router.get('/api/memory/projects', async (c) => {
        let dirs: string[];
        try {
            dirs = await fs.readdir(projectsMemoryParent());
        } catch {
            return c.json({ code: 0, data: [] });
        }
        const projectStore = getProjectStore();
        const list = await Promise.all(
            dirs.map(async (projectId) => {
                const items = await getMemoryStore(resolveMemoryRoot('project', projectId)).list();
                if (items.length === 0) return null;
                const project = await projectStore.get(projectId).catch(() => null);
                return {
                    projectId,
                    label: project?.name ?? projectId,
                    count: items.length,
                    updatedAt: items[0]?.updatedAt
                };
            })
        );
        return c.json({ code: 0, data: list.filter(Boolean) });
    });

    // 手动触发整理（设置页「立即整理」）：force 跳过时间闸，仍走进程锁；后台执行、立即返回
    router.post('/api/memory/dream', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { projectId?: unknown } | null;
        const projectId = body && typeof body.projectId === 'string' ? body.projectId : undefined;
        void runMemoryDream({ projectId, force: true });
        return c.json({ code: 0, data: { started: true } });
    });

    return router;
}
