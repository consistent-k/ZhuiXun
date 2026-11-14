import { createLogger } from '@/platform/logging/index';

const log = createLogger('SkillHubClient');

const USER_AGENT = 'zhuixun-SkillHub/1.0';

export interface SkillHubClientConfig {
    apiBase: string;
    timeoutMs: number;
}

function trimBase(raw: string): string {
    return String(raw || '').replace(/\/$/, '');
}

/** slug 清洗：取末段、去 `@`，仅允许 kebab/字母数字下划线（上游 slug 偶有下划线），拒绝路径穿越。 */
export function sanitizeSlug(raw: string): string {
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed.includes('..') || trimmed.includes('\\') || trimmed.includes('\0')) {
        throw new Error(`无效 slug：${raw}`);
    }
    const s = trimmed.replace(/^@/, '');
    const slug = s.includes('/') ? (s.split('/').filter(Boolean).pop() ?? '') : s;
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(slug)) throw new Error(`无效 slug：${raw}`);
    return slug.toLowerCase();
}

/**
 * 从规范名 `@namespace/slug` 中取出 `namespace` 段（含前导 `@`）用于下载消歧。
 *
 * 注意：SkillHub 允许**不同 namespace 发布同一 slug**（如 `@indiv-ebandao/dev-expert` 与
 * `@user_814dbe54/dev-expert`）。只按 slug 下载会恒拿 namespace 默认那个，装错技能。故下载时带上
 * namespace 精确命中。非规范名（无 `@.../...` 结构）返回 ''（退化为只按 slug）。
 */
export function namespaceFromCanonical(canonical: unknown): string {
    const s = String(canonical ?? '').trim();
    const m = s.match(/^@([a-z0-9][a-z0-9_-]{0,127})(?:\/[^/]+)?$/i);
    return m ? `@${m[1]}` : '';
}

/** 版本号校验（宽松）：数字字母点连字符加号，拒绝异常输入。空串返回 ''。 */
export function sanitizeVersion(raw: unknown): string {
    const v = String(raw ?? '')
        .trim()
        .replace(/^v/i, '');
    if (!v) return '';
    if (!/^[0-9a-z][0-9a-z._+-]{0,31}$/i.test(v)) throw new Error('无效版本');
    return v;
}

async function fetchJson<T>(url: string, cfg: SkillHubClientConfig, signal?: AbortSignal): Promise<T> {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: signal ?? AbortSignal.timeout(cfg.timeoutMs)
    });
    if (!res.ok) throw new Error(`SkillHub 请求失败 HTTP ${res.status}`);
    return (await res.json()) as T;
}

/**
 * 搜索 / 浏览技能。query 为空时浏览热门。
 *
 * 关键：SkillHub `/api/skills` 的真实查询参数是 `keyword`（不是 `q`）、`sortBy` + `order`、
 * `page` + `pageSize`（不是 `limit` / `offset`）。早期误用 `q`/`limit`/`offset` 会被上游忽略 →
 * 返回与关键词无关的默认热门列表。这里按 limit/offset 换算成 page/pageSize（页内对齐，offset
 * 未对齐 pageSize 时上层按 slug 去重兜底）。
 */
export function searchSkillsRaw(
    cfg: SkillHubClientConfig,
    params: { q?: string; category?: string; source?: string; sort?: string; limit: number; offset: number },
    signal?: AbortSignal
): Promise<unknown> {
    const pageSize = Math.max(1, Math.min(100, Math.floor(params.limit) || 12));
    const page = Math.floor(Math.max(0, params.offset) / pageSize) + 1;
    const sp = new URLSearchParams();
    if (params.q) sp.set('keyword', params.q);
    if (params.category) sp.set('category', params.category);
    if (params.source) sp.set('source', params.source);
    sp.set('sortBy', params.sort || 'score');
    sp.set('order', 'desc');
    sp.set('page', String(page));
    sp.set('pageSize', String(pageSize));
    return fetchJson(`${trimBase(cfg.apiBase)}/api/skills?${sp.toString()}`, cfg, signal);
}

/**
 * 技能详情。`namespace`（含前导 `@`，或整串 canonicalName）用于同 slug 跨 namespace 消歧——缺省时上游
 * 只按 slug 返回 namespace 默认那个，于是两个同 slug 技能的详情页会完全相同（实测可复现）。
 */
export function fetchSkillDetailRaw(
    cfg: SkillHubClientConfig,
    slug: string,
    signal?: AbortSignal,
    namespace?: string
): Promise<unknown> {
    const id = sanitizeSlug(slug);
    const ns = namespaceFromCanonical(namespace);
    const qs = ns ? `?namespace=${encodeURIComponent(ns)}` : '';
    return fetchJson(`${trimBase(cfg.apiBase)}/api/v1/skills/${encodeURIComponent(id)}${qs}`, cfg, signal);
}

/** 版本历史。`namespace` 同 fetchSkillDetailRaw：不带会把两个同 slug 技能的版本历史混在一起返回。 */
export function fetchSkillVersionsRaw(
    cfg: SkillHubClientConfig,
    slug: string,
    signal?: AbortSignal,
    namespace?: string
): Promise<unknown> {
    const id = sanitizeSlug(slug);
    const ns = namespaceFromCanonical(namespace);
    const qs = ns ? `?namespace=${encodeURIComponent(ns)}` : '';
    return fetchJson(`${trimBase(cfg.apiBase)}/api/v1/skills/${encodeURIComponent(id)}/versions${qs}`, cfg, signal);
}

/** 技能包体积硬上限（下载前防御；与 store 的解压上限互补）。 */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * 下载技能 zip 字节。
 *
 * 注意：SkillHub download 返回 302 跳转到腾讯 COS（另一 host），全局 fetch 默认跟随重定向即可；
 * 但需校验最终响应确为 zip（content-type 含 zip/octet-stream 或 PK 魔数），并限制体积。
 *
 * `namespace`（含前导 `@`）用于同 slug 多 namespace 的消歧（见 namespaceFromCanonical）；缺省时上游
 * 按 namespace 默认技能返回。
 */
export async function downloadSkillZip(
    cfg: SkillHubClientConfig,
    slug: string,
    version?: string,
    signal?: AbortSignal,
    namespace?: string
): Promise<Uint8Array> {
    const id = sanitizeSlug(slug);
    const ver = sanitizeVersion(version);
    const sp = new URLSearchParams({ slug: id, source: 'zhuixun' });
    if (ver) sp.set('version', ver);
    const ns = namespaceFromCanonical(namespace);
    if (ns) sp.set('namespace', ns);
    const url = `${trimBase(cfg.apiBase)}/api/v1/download?${sp.toString()}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: signal ?? AbortSignal.timeout(cfg.timeoutMs + 15000)
    });
    if (!res.ok) throw new Error(`SkillHub 下载失败 HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('技能包体积超限');
    const contentType = res.headers.get('content-type') ?? '';
    const looksZip = /zip|octet-stream/i.test(contentType) || (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b);
    if (!looksZip) {
        log.warn('下载结果非 zip', { slug: id, contentType, size: buf.length });
        throw new Error(`SkillHub 下载结果不是 zip 包：${id}`);
    }
    return buf;
}
