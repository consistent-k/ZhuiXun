import { type Handler, Hono } from 'hono';

import type { SkillUpsertInput } from '@/modules/skills';
import type { SkillRegistry } from '@/modules/skills';
import { isValidSkillId } from '@/modules/skills';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('Skills');

/** 从请求体解析并校验用户技能字段；校验失败返回错误串（供调用方转 400），成功返回 input。 */
function parseUpsertBody(body: unknown, opts: { requireName: boolean }): { error?: string; input?: SkillUpsertInput } {
    // 请求体是任意 JSON，先窄化成可索引对象再逐个读字段
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    const systemPrompt = typeof b.systemPrompt === 'string' ? b.systemPrompt.trim() : '';

    if (!description) return { error: 'description 为必填项' };
    if (!systemPrompt) return { error: 'systemPrompt 为必填项' };

    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (opts.requireName) {
        if (!name) return { error: 'name 为必填项' };
        if (!isValidSkillId(name)) {
            return { error: 'name 仅支持小写字母、数字、连字符，且以字母开头（kebab-case）' };
        }
    }

    const triggers = Array.isArray(b.triggers)
        ? b.triggers.filter((t: unknown): t is string => typeof t === 'string' && t.trim() !== '')
        : undefined;

    const toStringArray = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '') : undefined;

    return {
        input: {
            name,
            displayName: typeof b.displayName === 'string' ? b.displayName.trim() : undefined,
            description,
            triggers,
            allowedTools: toStringArray(b.allowedTools),
            disallowedTools: toStringArray(b.disallowedTools),
            systemPrompt
        }
    };
}

/** 把 registry 抛出的错误 code 映射成 HTTP 状态码 */
function statusForError(err: unknown): { status: 400 | 403 | 404 | 409 | 500; message: string } {
    const message = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
    if (code === 'CONFLICT') return { status: 409, message };
    if (code === 'FORBIDDEN') return { status: 403, message };
    if (code === 'NOT_FOUND') return { status: 404, message };
    // store 的 id 校验/路径越界等归为 400
    if (/非法技能 id|路径越界/.test(message)) return { status: 400, message };
    return { status: 500, message };
}

/**
 * 技能管理接口（列表 + CRUD）。
 *
 * 用 getter 而不是直接传 SkillRegistry，因为 registry 是在服务启动时
 * 异步初始化的，构造路由时它还不存在（与 createChatRouter 一致）。
 *
 * 写接口（POST/PUT/DELETE）只对 source==='user' 的技能生效；内置技能只读，返回 403。
 */
// 仅暴露路由消费的注册表能力，保留生产 getter 的惰性语义。
type SkillsRouteRegistry = Pick<
    SkillRegistry,
    | 'listMetadata'
    | 'loadAll'
    | 'listLoaded'
    | 'getMetadataById'
    | 'getSkillSource'
    | 'get'
    | 'hasUserDir'
    | 'createUserSkill'
    | 'updateUserSkill'
    | 'removeUserSkill'
    | 'toggleSkill'
    | 'importSkill'
    | 'exportSkill'
>;

export function createSkillsRouter(getRegistry: () => SkillsRouteRegistry | undefined) {
    const skillsRouter = new Hono();

    skillsRouter.get('/api/skills', async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪（技能注册表未初始化）' }, 503);
        }

        const metadata = registry.listMetadata();

        // 工具信息需要完整加载技能后才有，首次请求触发加载，之后走缓存
        try {
            await registry.loadAll();
        } catch (error) {
            log.error('loadAll 失败，降级为仅返回技能元信息', { err: error });
        }
        const toolInfoBySkill = new Map(registry.listLoaded().map((s) => [s.id, s.toolInfo]));

        const skillList = metadata.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            source: s.source,
            editable: s.editable,
            disabled: s.disabled,
            tools: (toolInfoBySkill.get(s.id) ?? []).map((t) => ({
                name: t.name,
                description: t.description
            }))
        }));
        return c.json({ code: 0, data: skillList });
    });

    skillsRouter.get('/api/skills/:id', async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const id = c.req.param('id');
        const meta = registry.getMetadataById(id);
        if (!meta) {
            return c.json({ code: 404, message: `技能 "${id}" 不存在` }, 404);
        }

        try {
            const source = await registry.getSkillSource(id);
            const skill = await registry.get(id);
            return c.json({
                code: 0,
                data: {
                    id: meta.id,
                    source: meta.source,
                    editable: meta.editable,
                    displayName: source?.displayName,
                    description: source?.description ?? meta.description,
                    triggers: source?.triggers ?? meta.triggers,
                    allowedTools: source?.allowedTools,
                    disallowedTools: source?.disallowedTools,
                    systemPrompt: source?.systemPrompt ?? '',
                    tools: (skill?.toolInfo ?? []).map((t) => ({ name: t.name, description: t.description }))
                }
            });
        } catch (error) {
            log.error('读取技能详情失败', { skillId: id, err: error });
            return c.json({ code: 500, message: '读取技能详情失败' }, 500);
        }
    });

    skillsRouter.post('/api/skills', async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }
        if (!registry.hasUserDir()) {
            return c.json({ code: 403, message: '未配置用户技能目录，无法新增' }, 403);
        }

        const body = await c.req.json().catch(() => ({}));
        const { error, input } = parseUpsertBody(body, { requireName: true });
        if (error || !input) {
            return c.json({ code: 400, message: error }, 400);
        }

        try {
            const meta = await registry.createUserSkill(input);
            return c.json({ code: 0, data: { id: meta.id } });
        } catch (err) {
            const { status, message } = statusForError(err);
            return c.json({ code: status, message }, status);
        }
    });

    skillsRouter.put('/api/skills/:id', async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const id = c.req.param('id');
        const body = await c.req.json().catch(() => ({}));
        // 编辑不改 id，name 由 registry 强制对齐为 id，这里不要求 body.name
        const { error, input } = parseUpsertBody(body, { requireName: false });
        if (error || !input) {
            return c.json({ code: 400, message: error }, 400);
        }

        try {
            const meta = await registry.updateUserSkill(id, input);
            return c.json({ code: 0, data: { id: meta.id } });
        } catch (err) {
            const { status, message } = statusForError(err);
            return c.json({ code: status, message }, status);
        }
    });

    skillsRouter.delete('/api/skills/:id', async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }

        const id = c.req.param('id');
        try {
            await registry.removeUserSkill(id);
            return c.json({ code: 0, data: { id, deleted: true } });
        } catch (err) {
            const { status, message } = statusForError(err);
            return c.json({ code: status, message }, status);
        }
    });

    // 启用/停用（builtin/user 均可，状态存用户目录）
    skillsRouter.patch('/api/skills/:id/toggle', async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }
        const id = c.req.param('id');
        try {
            const disabled = await registry.toggleSkill(id);
            return c.json({ code: 0, data: { id, disabled } });
        } catch (err) {
            const { status, message } = statusForError(err);
            return c.json({ code: status, message }, status);
        }
    });

    // 上传技能包：.md（单文件）或 .zip（含 SKILL.md + references/examples）
    const handleUpload: Handler = async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }
        if (!registry.hasUserDir()) {
            return c.json({ code: 403, message: '未配置用户技能目录，无法上传' }, 403);
        }

        let file: unknown;
        try {
            const body = await c.req.parseBody();
            file = body['file'];
        } catch {
            return c.json({ code: 400, message: '请求体解析失败（需 multipart/form-data，字段名 file）' }, 400);
        }
        if (!file || typeof (file as File).arrayBuffer !== 'function') {
            return c.json({ code: 400, message: '缺少上传文件（字段名 file）' }, 400);
        }

        const f = file as File;
        const name = (f.name || '').toLowerCase();
        try {
            let id: string;
            if (name.endsWith('.zip')) {
                const buf = new Uint8Array(await f.arrayBuffer());
                id = await registry.importSkill('zip', buf);
            } else if (name.endsWith('.md') || name === '' || name.endsWith('skill')) {
                const text = await f.text();
                id = await registry.importSkill('md', text);
            } else {
                return c.json({ code: 400, message: '仅支持 .md 或 .zip 文件' }, 400);
            }
            return c.json({ code: 0, data: { id } });
        } catch (err) {
            const { status, message } = statusForError(err);
            // 导入类错误多为内容问题，未被 code 标记的归 400
            return c.json({ code: status === 500 ? 400 : status, message }, status === 500 ? 400 : status);
        }
    };
    skillsRouter.post('/api/skills/upload', handleUpload);
    // import 与 upload 等价，语义面向跨设备迁移
    skillsRouter.post('/api/skills/import', handleUpload);

    // 导出技能为 .zip
    skillsRouter.get('/api/skills/:id/export', async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        }
        const id = c.req.param('id');
        try {
            const zip = await registry.exportSkill(id);
            c.header('Content-Type', 'application/zip');
            c.header('Content-Disposition', `attachment; filename="${id}.zip"`);
            return c.body(zip as unknown as ArrayBuffer);
        } catch (err) {
            const { status, message } = statusForError(err);
            return c.json({ code: status, message }, status);
        }
    });

    return skillsRouter;
}
