import { Hono } from 'hono';

import { getSkillhubSettings, updateSkillhubSettings } from '@/config/settings-store';
import type { SkillRegistry } from '@/modules/skills';
import {
    fetchSkillDetailRaw,
    fetchSkillVersionsRaw,
    searchSkillsRaw,
    sanitizeSlug,
    type SkillHubClientConfig
} from '@/modules/skills';
import { installMarketSkill } from '@/modules/skills';
import { mapDetail, mapSearch } from '@/modules/skills';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('SkillHubRoutes');

function clientConfig(): SkillHubClientConfig {
    const cfg = getSkillhubSettings();
    return { apiBase: cfg.apiBase, timeoutMs: cfg.timeoutMs };
}

/**
 * 本地已安装技能的身份集合（小写），用于标注市场卡片「已安装」。
 * 同时放入本地 id 与来源 canonicalName（`@namespace/slug`，SkillHub 安装的技能才有）：卡片有
 * canonicalName 时按 canonicalName 比对（同 slug 跨 namespace 消歧），否则退回 slug→id。两类字符串不会
 * 冲突（canonicalName 以 `@` 开头）。
 */
function installedSet(registry: SkillRegistry): Set<string> {
    const set = new Set<string>();
    for (const m of registry.listMetadata()) {
        set.add(m.id.toLowerCase());
        if (m.sourceCanonical) set.add(m.sourceCanonical.toLowerCase());
    }
    return set;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
}

/**
 * SkillHub 技能广场接口。registry 用 getter 注入（服务启动时异步初始化，构造路由时还不存在）。
 */
export function createSkillHubRouter(getRegistry: () => SkillRegistry | undefined) {
    const router = new Hono();

    // 配置读写（真源在 settings.json 的 skillhub 段）
    router.get('/api/skillhub/config', (c) => {
        return c.json({ code: 0, data: getSkillhubSettings() });
    });

    router.put('/api/skillhub/config', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const patch: { apiBase?: string; maxResults?: number; timeoutMs?: number } = {};
        if (typeof body?.apiBase === 'string') patch.apiBase = body.apiBase.trim();
        if (body?.maxResults !== undefined) patch.maxResults = Number(body.maxResults);
        if (body?.timeoutMs !== undefined) patch.timeoutMs = Number(body.timeoutMs);
        try {
            return c.json({ code: 0, data: updateSkillhubSettings(patch) });
        } catch (err) {
            log.error('保存 SkillHub 配置失败', { err });
            return c.json({ code: 500, message: '保存 SkillHub 配置失败' }, 500);
        }
    });

    // 搜索 / 浏览
    router.get('/api/skillhub/search', async (c) => {
        const registry = getRegistry();
        if (!registry) return c.json({ code: 503, message: '服务尚未就绪' }, 503);

        const cfg = getSkillhubSettings();
        const q = (c.req.query('q') || '').trim();
        const category = (c.req.query('category') || '').trim() || undefined;
        const source = (c.req.query('source') || '').trim() || undefined;
        const sort = (c.req.query('sort') || '').trim() || undefined;
        const limit = clampInt(c.req.query('limit'), cfg.maxResults, 1, 80);
        const offset = clampInt(c.req.query('offset'), 0, 0, 100000);

        try {
            const raw = await searchSkillsRaw(
                { apiBase: cfg.apiBase, timeoutMs: cfg.timeoutMs },
                { q, category, source, sort, limit, offset }
            );
            const result = mapSearch(raw, { query: q, category, limit, offset, installed: installedSet(registry) });
            return c.json({ code: 0, data: result });
        } catch (err) {
            log.error('SkillHub 搜索失败', { q, err });
            return c.json(
                { code: 502, message: `SkillHub 搜索失败：${err instanceof Error ? err.message : String(err)}` },
                502
            );
        }
    });

    // 详情 + 版本
    router.get('/api/skillhub/skills/:slug', async (c) => {
        const registry = getRegistry();
        if (!registry) return c.json({ code: 503, message: '服务尚未就绪' }, 503);

        let slug: string;
        try {
            slug = sanitizeSlug(c.req.param('slug'));
        } catch {
            return c.json({ code: 400, message: '无效的技能 slug' }, 400);
        }

        const cfg = clientConfig();
        // canonicalName（`@namespace/slug`）用于同 slug 跨 namespace 消歧；缺省则取 namespace 默认技能。
        const canonicalName = (c.req.query('canonicalName') || '').trim() || undefined;
        try {
            const [detailRaw, versionsRaw] = await Promise.all([
                fetchSkillDetailRaw(cfg, slug, undefined, canonicalName),
                fetchSkillVersionsRaw(cfg, slug, undefined, canonicalName).catch(() => ({}))
            ]);
            const detail = mapDetail(detailRaw, versionsRaw, installedSet(registry));
            if (!detail) return c.json({ code: 404, message: `技能 "${slug}" 不存在` }, 404);
            return c.json({ code: 0, data: detail });
        } catch (err) {
            log.error('SkillHub 详情获取失败', { slug, err });
            return c.json(
                { code: 502, message: `获取技能详情失败：${err instanceof Error ? err.message : String(err)}` },
                502
            );
        }
    });

    // 下载安装
    router.post('/api/skillhub/install', async (c) => {
        const registry = getRegistry();
        if (!registry) return c.json({ code: 503, message: '服务尚未就绪' }, 503);
        if (!registry.hasUserDir()) return c.json({ code: 403, message: '未配置用户技能目录，无法安装' }, 403);

        const body = await c.req.json().catch(() => ({}));
        const slugRaw = typeof body?.slug === 'string' ? body.slug : '';
        const version = typeof body?.version === 'string' ? body.version : undefined;
        const canonicalName = typeof body?.canonicalName === 'string' ? body.canonicalName : undefined;
        const displayName = typeof body?.displayName === 'string' ? body.displayName : undefined;
        if (!slugRaw) return c.json({ code: 400, message: 'slug 为必填项' }, 400);

        try {
            const result = await installMarketSkill(
                registry,
                clientConfig(),
                slugRaw,
                version,
                undefined,
                canonicalName,
                displayName
            );
            return c.json({ code: 0, data: result });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error('SkillHub 安装失败', { slug: slugRaw, err });
            // 命名不合规 / 缺 SKILL.md / 体积超限等多为内容问题，归 400；其余归 502。
            const isContentErr = /slug|SKILL\.md|命名规则|超限|非法路径|不是 zip|无效/.test(message);
            const status = isContentErr ? 400 : 502;
            return c.json({ code: status, message }, status);
        }
    });

    return router;
}
