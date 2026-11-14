import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';

import { getConversationStore } from '@/modules/conversations';
import { validateDir } from '@/modules/projects';
import { getProjectStore, isValidProjectId, type ProjectRoot, type ProjectUpsert } from '@/modules/projects';

/**
 * 项目管理 REST：供前端项目仓储读写。
 * 项目真源在后端 `~/.zhuixun/projects/<id>/`（project.json）。
 * 响应统一 `{ code, data, message }`，成功码 0。
 */

/** 解析 roots 入参：接受 [{path, primary?}] 或字符串数组；空数组表示清空。非数组返回 undefined（不改动）。 */
function parseRoots(raw: unknown): ProjectRoot[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const roots: ProjectRoot[] = [];
    for (const item of raw) {
        if (typeof item === 'string') {
            const p = item.trim();
            if (p) roots.push({ path: p });
        } else if (item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string') {
            const p = ((item as { path: string }).path || '').trim();
            if (p) roots.push({ path: p, primary: (item as { primary?: unknown }).primary === true });
        }
    }
    return roots;
}

/** 边界层形状校验：畸形请求体尽早拒绝，避免脏数据落盘。 */
function parseUpsert(body: unknown): ProjectUpsert | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (typeof b.name !== 'string' || !b.name.trim()) return null;

    const input: ProjectUpsert = { name: b.name.trim() };
    if (typeof b.icon === 'string') input.icon = b.icon;
    if (typeof b.color === 'string') input.color = b.color;
    if (typeof b.archived === 'boolean') input.archived = b.archived;
    if (typeof b.instructions === 'string') input.instructions = b.instructions;
    if (typeof b.defaultSkillId === 'string') input.defaultSkillId = b.defaultSkillId;
    if (Array.isArray(b.skillPreset) && b.skillPreset.every((s) => typeof s === 'string')) {
        input.skillPreset = b.skillPreset as string[];
    }
    // roots：工作目录集合。显式传入即整体覆盖（空数组清空）
    const roots = parseRoots(b.roots);
    if (roots) input.roots = roots;
    if (typeof b.trusted === 'boolean') input.trusted = b.trusted;
    if (typeof b.createdAt === 'number') input.createdAt = b.createdAt;
    return input;
}

/** 校验一组工作目录：任一不是已存在的绝对目录则返回错误文案，全部通过返回 null。 */
async function validateRoots(roots?: ProjectRoot[]): Promise<string | null> {
    if (!roots) return null;
    for (const r of roots) {
        const check = await validateDir(r.path);
        if (!check.ok) return `工作目录无效：${r.path}（${check.reason}）`;
    }
    return null;
}

export function createProjectsRouter() {
    const router = new Hono();

    router.get('/api/projects', async (c) => {
        const includeDeleted = c.req.query('includeDeleted') === '1';
        const data = await getProjectStore().list({ includeDeleted });
        return c.json({ code: 0, data });
    });

    // 静态子路径（validate-path / browse-dir）必须注册在 /:id 之前，
    // 否则会被参数路由捕获成 id='browse-dir' 而返回 404（与 conversations 的 /history 同理）。

    // 校验工作目录路径（前端「浏览/输入」后即时校验）
    router.post('/api/projects/validate-path', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null;
        if (typeof body?.path !== 'string' || !body.path.trim()) {
            return c.json({ code: 0, data: { ok: false, reason: '请填写路径' } });
        }
        const result = await validateDir(body.path.trim());
        return c.json({ code: 0, data: result });
    });

    // 后端目录浏览器：列出某个目录下的子目录，供前端目录导航弹窗选择工作目录。
    // 浏览的是「后端所在主机」的文件系统——这正是项目主根（shell cwd）需要的路径，
    // 且浏览器/桌面壳两种前端形态行为一致（不受浏览器不暴露绝对路径的限制）。
    router.get('/api/projects/browse-dir', async (c) => {
        const raw = c.req.query('path');
        const target = raw && raw.trim() ? raw.trim() : os.homedir();
        if (!path.isAbsolute(target)) {
            return c.json({ code: 400, message: '路径必须是绝对路径' }, 400);
        }
        try {
            const dirents = await fs.readdir(target, { withFileTypes: true });
            const entries: { name: string; path: string }[] = [];
            for (const d of dirents) {
                if (d.name.startsWith('.')) continue; // 跳过隐藏目录，减少噪音
                let isDir = d.isDirectory();
                if (!isDir && d.isSymbolicLink()) {
                    try {
                        isDir = (await fs.stat(path.join(target, d.name))).isDirectory();
                    } catch {
                        isDir = false;
                    }
                }
                if (isDir) entries.push({ name: d.name, path: path.join(target, d.name) });
            }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            const parent = path.dirname(target);
            return c.json({
                code: 0,
                data: {
                    path: target,
                    parent: parent === target ? null : parent, // 到根时无上级
                    home: os.homedir(),
                    entries
                }
            });
        } catch {
            return c.json({ code: 400, message: '目录不存在或无访问权限' }, 400);
        }
    });

    // 详情：参数路由放在所有静态子路径之后，避免捕获 browse-dir / validate-path
    router.get('/api/projects/:id', async (c) => {
        const project = await getProjectStore().get(c.req.param('id'));
        if (!project) return c.json({ code: 404, message: '项目不存在' }, 404);
        return c.json({ code: 0, data: project });
    });

    // 创建：id 由服务端生成（与会话一致用 uuid 风格），返回元信息
    router.post('/api/projects', async (c) => {
        const body = await c.req.json().catch(() => null);
        const upsert = parseUpsert(body);
        if (!upsert) return c.json({ code: 400, message: '请求参数不合法' }, 400);
        const rootsError = await validateRoots(upsert.roots);
        if (rootsError) return c.json({ code: 400, message: rootsError }, 400);
        const id = crypto.randomUUID();
        const data = await getProjectStore().upsert(id, upsert);
        return c.json({ code: 0, data });
    });

    // 更新：名称/指令/技能集/归档/工作目录集合/信任等
    router.put('/api/projects/:id', async (c) => {
        const id = c.req.param('id');
        if (!isValidProjectId(id)) return c.json({ code: 400, message: '非法项目 id' }, 400);
        const body = await c.req.json().catch(() => null);
        const upsert = parseUpsert(body);
        if (!upsert) return c.json({ code: 400, message: '请求参数不合法' }, 400);
        const rootsError = await validateRoots(upsert.roots);
        if (rootsError) return c.json({ code: 400, message: rootsError }, 400);
        const existing = await getProjectStore().get(id);
        if (!existing) return c.json({ code: 404, message: '项目不存在' }, 404);
        const data = await getProjectStore().upsert(id, upsert);
        return c.json({ code: 0, data });
    });

    // 信任开关：单独切换 trusted（带确认语义由前端弹窗承载）
    router.put('/api/projects/:id/trust', async (c) => {
        const id = c.req.param('id');
        if (!isValidProjectId(id)) return c.json({ code: 400, message: '非法项目 id' }, 400);
        const body = (await c.req.json().catch(() => null)) as { trusted?: unknown } | null;
        if (typeof body?.trusted !== 'boolean') return c.json({ code: 400, message: '缺少 trusted 布尔值' }, 400);
        const existing = await getProjectStore().get(id);
        if (!existing) return c.json({ code: 404, message: '项目不存在' }, 404);
        const data = await getProjectStore().upsert(id, { name: existing.name, trusted: body.trusted });
        return c.json({ code: 0, data });
    });

    // 删除：默认软删（可恢复、保留项目记忆）；?hard=1 彻底删，?cascade=1 时连同会话一起删
    router.delete('/api/projects/:id', async (c) => {
        const id = c.req.param('id');
        if (!isValidProjectId(id)) return c.json({ code: 400, message: '非法项目 id' }, 400);
        const hard = c.req.query('hard') === '1';
        if (!hard) {
            // 软删：会话复位未分组（保持侧栏可见），项目目录与记忆保留、可恢复
            const movedSessions = await getConversationStore().handleProjectRemoval(id, false);
            await getProjectStore().softDelete(id);
            return c.json({ code: 0, data: { id, mode: 'soft', movedSessions } });
        }
        const cascade = c.req.query('cascade') === '1';
        const movedSessions = await getConversationStore().handleProjectRemoval(id, cascade);
        await getProjectStore().hardDelete(id);
        return c.json({ code: 0, data: { id, mode: 'hard', cascade, movedSessions } });
    });

    // 恢复软删项目
    router.post('/api/projects/:id/restore', async (c) => {
        const id = c.req.param('id');
        if (!isValidProjectId(id)) return c.json({ code: 400, message: '非法项目 id' }, 400);
        const data = await getProjectStore().restore(id);
        if (!data) return c.json({ code: 404, message: '项目不存在' }, 404);
        return c.json({ code: 0, data });
    });

    return router;
}
