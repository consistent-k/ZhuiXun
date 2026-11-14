import { parseSkillMarkdownString, serializeSkillMarkdown } from '../loader';

import type {
    MarketSkillCard,
    MarketSkillDetail,
    MarketSearchResult,
    MarketVersion,
    SkillHubSecurity,
    SkillHubSecurityReport,
    SkillHubSecurityStatus
} from './types';

/** SkillHub 技能主页基址（展示用）。 */
const WEB_BASE = 'https://skillhub.cn';

/** 场景分类 key → 中文展示名（与 SkillHub 官方一致）。 */
const CATEGORY_LABELS: Record<string, string> = {
    'office-efficiency': '办公效率',
    'content-creation': '内容创作',
    'dev-programming': '开发编程',
    'data-analysis': '数据分析',
    'design-media': '设计多媒体',
    'ai-agent': 'AI Agent',
    'knowledge-management': '知识管理',
    'business-ops': '商业运营',
    education: '教育学习',
    professional: '行业专业',
    'it-ops-security': 'IT 运维与安全',
    'life-service': '生活服务'
};

function categoryLabel(key: string): string {
    return CATEGORY_LABELS[key] || key;
}

const SECURITY_ORDER: Record<SkillHubSecurityStatus, number> = {
    malicious: 4,
    suspicious: 3,
    scanning: 2,
    benign: 1,
    unknown: 0
};

function toStatus(raw: unknown): SkillHubSecurityStatus {
    const s = String(raw || '').toLowerCase();
    return s === 'malicious' || s === 'suspicious' || s === 'scanning' || s === 'benign' ? s : 'unknown';
}

/** 聚合 securityReports（keen / sanbu...）为前端安全信息，取最严重状态。缺省返回 undefined。 */
export function mapSecurity(raw: unknown): SkillHubSecurity | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const reports: Record<string, SkillHubSecurityReport> = {};
    let worst: SkillHubSecurityStatus = 'unknown';
    for (const [scanner, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        const status = toStatus(v.status);
        reports[scanner] = {
            status,
            statusText: typeof v.statusText === 'string' ? v.statusText : undefined,
            reportUrl: typeof v.reportUrl === 'string' ? v.reportUrl : undefined
        };
        if (SECURITY_ORDER[status] > SECURITY_ORDER[worst]) worst = status;
    }
    return Object.keys(reports).length ? { worst, reports } : undefined;
}

function num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * SkillHub 普通用户的 handle / ownerName / namespace.displayName 都是同一个自动生成 ID
 * （如 `user_ae71b645` / `u_2199380c` / `org-6mle9qko`），没有单独的昵称字段可用。
 * 这里只采用「看起来像真实昵称 / handle」的值（如 `infimind`），自动生成 ID 一律返回 undefined，
 * 前端据此隐藏「作者」行而不是展示一串 ID；认证企业 / 机构另有 publisher.name 单独展示。
 */
const AUTO_GENERATED_ID = /^(user_|u_|org-|org_)[0-9a-z]+$/i;

function prettyOwner(...candidates: Array<unknown>): string | undefined {
    for (const c of candidates) {
        const s = String(c ?? '').trim();
        if (s && !AUTO_GENERATED_ID.test(s)) return s;
    }
    return undefined;
}

/** 把一条 SkillHub 技能原始对象映射为前端卡片。无法取得 slug 时返回 null。 */
export function mapCard(raw: unknown, installed: Set<string>): MarketSkillCard | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const ns = (r.namespace || {}) as Record<string, unknown>;
    const stats = (r.stats || {}) as Record<string, unknown>;
    const slug = String(r.slug || ns.publicSlug || '').trim();
    if (!slug) return null;
    const latest = (r.latestVersion || {}) as Record<string, unknown>;
    const publisher = (r.publisher || {}) as Record<string, unknown>;
    const labels = (r.labels || {}) as Record<string, unknown>;
    const category = String(r.category || '').trim();
    const canonicalName = ns.canonicalName ? String(ns.canonicalName) : undefined;
    const card: MarketSkillCard = {
        slug,
        name: String(r.displayName || r.name || slug).trim(),
        description: String(r.description_zh || r.description || r.summary_zh || r.summary || '').trim(),
        category,
        categoryLabel: categoryLabel(category),
        version: String(latest.version || r.version || '').trim(),
        downloads: num(stats.downloads ?? r.downloads),
        stars: num(stats.stars ?? r.stars),
        installs: num(stats.installs ?? r.installs),
        requiresApiKey: String(labels.requires_api_key) === 'true',
        iconUrl: r.iconUrl ? String(r.iconUrl) : undefined,
        owner: prettyOwner(r.ownerDisplayName, ns.handle, r.ownerName),
        canonicalName,
        overview: r.overviewMd ? String(r.overviewMd) : undefined,
        source: r.source ? String(r.source) : undefined,
        // 「已安装」按 canonicalName 精确比对（SkillHub 允许同 slug 跨 namespace，只按 slug 会把两个不同
        // 技能同时标成已安装）。缺 canonicalName（极少数上游数据不全）才退回 slug。
        installed: canonicalName ? installed.has(canonicalName.toLowerCase()) : installed.has(slug.toLowerCase()),
        pageUrl: `${WEB_BASE}/skills/${encodeURIComponent(slug)}`
    };
    if (publisher.verified) {
        card.verified = true;
        if (publisher.name) card.publisherName = String(publisher.name);
    }
    const security = mapSecurity(r.securityReports);
    if (security) card.security = security;
    return card;
}

/** 从搜索响应 `{code,data:{skills:[]}}` 构造前端搜索结果。 */
export function mapSearch(
    raw: unknown,
    opts: { query: string; category?: string; limit: number; offset: number; installed: Set<string> }
): MarketSearchResult {
    // raw 可能是「{data:{skills}}」信封，也可能是裸数组，先窄化成可索引的对象再取字段
    const data = (raw && typeof raw === 'object' && 'data' in raw ? (raw as Record<string, unknown>).data : raw) ?? {};
    const dataObj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const list: unknown[] = Array.isArray(dataObj.skills)
        ? dataObj.skills
        : Array.isArray(dataObj.items)
          ? dataObj.items
          : [];
    // 以 canonicalName（真实唯一身份，`@namespace/slug`）为准去重，回退 slug：防御上游 / 翻页重叠把同一
    // 技能返回两次。注意：同 slug 不同 namespace 是**不同**技能（canonicalName 不同），不会被误并——
    // SkillHub 允许同 slug 跨 namespace，这类条目理应各自保留。
    const seen = new Set<string>();
    const items: MarketSkillCard[] = [];
    for (const it of list) {
        const card = mapCard(it, opts.installed);
        if (!card) continue;
        const key = (card.canonicalName || card.slug).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(card);
    }
    const total = num(dataObj.total) || opts.offset + items.length;
    return {
        query: opts.query,
        category: opts.category,
        items,
        total,
        offset: opts.offset,
        hasMore: opts.offset + items.length < total && items.length > 0
    };
}

/** 从详情响应 `{data:{skill,latestVersion,namespace,securityReports,owner,...}}` 构造卡片。 */
export function mapDetailCard(raw: unknown, installed: Set<string>): MarketSkillCard | null {
    const data = (raw && typeof raw === 'object' && 'data' in raw ? (raw as Record<string, unknown>).data : raw) ?? {};
    const dataObj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const skill = (dataObj.skill || {}) as Record<string, unknown>;
    const owner = (dataObj.owner || {}) as Record<string, unknown>;
    const merged = {
        ...skill,
        slug: dataObj.slug || skill.slug,
        namespace: dataObj.namespace || skill.namespace,
        latestVersion: dataObj.latestVersion || skill.latestVersion,
        securityReports: dataObj.securityReports || skill.securityReports,
        publisher: dataObj.publisher || skill.publisher,
        // 详情接口的 owner.displayName 才是真实作者昵称（如「技效人」），handle 仍是自动 ID。
        // 与 SkillHub 自己的详情页展示对齐：优先用 displayName。
        ownerDisplayName: owner.displayName,
        ownerName: owner.handle || skill.ownerName
    };
    return mapCard(merged, installed);
}

/** 从版本响应构造版本历史列表。 */
export function mapVersions(raw: unknown): MarketVersion[] {
    const data = (raw && typeof raw === 'object' && 'data' in raw ? (raw as Record<string, unknown>).data : raw) ?? {};
    const dataObj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const list: unknown[] = Array.isArray(dataObj.versions) ? dataObj.versions : [];
    return list
        .map((v) => {
            if (!v || typeof v !== 'object') return null;
            const r = v as Record<string, unknown>;
            const version = String(r.version || '').trim();
            if (!version) return null;
            const out: MarketVersion = { version };
            if (r.changelog) out.changelog = String(r.changelog);
            if (Number.isFinite(Number(r.createdAt))) out.createdAt = Number(r.createdAt);
            const security = mapSecurity(r.securityReports);
            if (security) out.security = security;
            return out;
        })
        .filter((x): x is MarketVersion => !!x);
}

/** 组装详情 DTO。 */
export function mapDetail(detailRaw: unknown, versionsRaw: unknown, installed: Set<string>): MarketSkillDetail | null {
    const card = mapDetailCard(detailRaw, installed);
    if (!card) return null;
    return { card, versions: mapVersions(versionsRaw) };
}

const SKILL_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * 归一化 SkillHub 技能 id：仅小写化（大小写不敏感），不做下划线→连字符的激进归一（D4：P0 仅报错）。
 * 不合规（下划线 / 以数字开头 / 空）直接抛清晰错误。
 */
export function normalizeSkillHubId(rawSlug: string): string {
    const id = String(rawSlug || '')
        .trim()
        .toLowerCase();
    if (!SKILL_ID_RE.test(id)) {
        throw new Error(
            `SkillHub 技能 id「${rawSlug}」不符合命名规则（需以字母开头的 kebab-case，暂不支持下划线/大写），当前无法安装`
        );
    }
    return id;
}

/** 把任意片段压成 kebab 段：小写、非 [a-z0-9] 归一为 `-`、去重去首尾 `-`。 */
function kebabSegment(raw: string): string {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * SkillHub 技能的**本地 id**：以 canonicalName（`@namespace/slug`）为准派生 `namespace-slug`，而不是裸 slug。
 *
 * 为什么不用裸 slug：不同 namespace 可发同名 slug（如 `@indiv-ebandao/dev-expert` 与
 * `@user_814dbe54/dev-expert`），而本地 id 同时是目录名/frontmatter.name。若都用 `dev-expert`，装第二个会
 * **原子 rename 顶掉第一个**——用户装了「编程专家.Skill」又装 dev-expert，列表里前者就消失了。按 canonicalName
 * 派生 id 可让两者各占一个目录共存；重装同一技能仍是同 id、幂等覆盖自身。
 *
 * 无 canonicalName（理论上市场安装都有）时退回裸 slug 的老行为。
 */
export function skillHubLocalId(canonicalName: string | undefined, rawSlug: string): string {
    const canonical = String(canonicalName ?? '').trim();
    const m = canonical.match(/^@([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/i);
    if (m) {
        const ns = kebabSegment(m[1]);
        const slug = kebabSegment(m[2]);
        let id = [ns, slug].filter(Boolean).join('-');
        if (!/^[a-z]/.test(id)) id = `sh-${id}`; // 保证以字母开头（SKILL_ID_RE 要求）
        if (SKILL_ID_RE.test(id)) return id;
    }
    return normalizeSkillHubId(rawSlug);
}

/**
 * 把 SkillHub 的 SKILL.md 归一化为 zhuixun frontmatter 形态：
 * - `name` → 以 canonicalName 派生的本地 id `namespace-slug`（见 skillHubLocalId，避免同 slug 跨 namespace 互相顶替）
 * - 展示名 → `metadata.display_name`：优先 zip 自带的 displayName/metadata.display_name，其次用 `opts.displayName`
 *   （SkillHub 市场卡片的展示名，如「编程专家.Skill」——很多技能 zip 的 SKILL.md 里 `name` 就是裸 slug、
 *   没有展示名，若不补充则「已安装」列表只会显示裸 id 而不是用户在市场看到的名字）。
 * - `opts.canonicalName`（如 `@indiv-ebandao/dev-expert`）→ `metadata.source_canonical`：**同 slug 多 namespace**
 *   时的唯一身份，用于「已安装」精确标注（避免两个同 slug 技能被同时标成已安装）。来自 SkillHub API，
 *   不在 zip 的 SKILL.md 里，故由 installer 显式传入。
 * - 保留 provenance：原 version / author / license / slug 写入正文注释，便于溯源与署名
 * - 正文原样保留
 */
export function normalizeSkillHubSkillMd(
    markdown: string,
    opts: { canonicalName?: string; displayName?: string } = {}
): string {
    const { frontmatter, body } = parseSkillMarkdownString(markdown);
    const fm = frontmatter as unknown as Record<string, unknown>;
    const rawSlug = String(fm.slug || fm.name || '').trim();
    const canonicalName = String(opts.canonicalName ?? '').trim();
    // 本地 id 以 canonicalName 派生（namespace-slug），避免同 slug 跨 namespace 互相顶替；无 canonical 退回裸 slug。
    const name = skillHubLocalId(canonicalName, rawSlug);
    const marketDisplay = String(opts.displayName ?? '').trim();
    // frontmatter.metadata 是未知形状的嵌套对象，先窄化成可索引对象再读 display_name
    const metadata =
        fm.metadata && typeof fm.metadata === 'object' ? (fm.metadata as Record<string, unknown>) : undefined;
    const displayName =
        (typeof fm.displayName === 'string' && fm.displayName.trim()) ||
        (metadata && typeof metadata.display_name === 'string' && metadata.display_name.trim()) ||
        // 市场展示名兜底：仅当它和本地 id 不同才写（相同则写入无意义，列表仍显示 id）。
        (marketDisplay && marketDisplay !== name ? marketDisplay : undefined) ||
        // 再兜底：id 做了 namespace 限定后已不等于裸 slug，用裸 slug 当展示名也比带 namespace 的 id 友好。
        (rawSlug && rawSlug !== name ? rawSlug : undefined) ||
        undefined;
    const description = String(fm.description || '').trim();
    const triggers = Array.isArray(fm.triggers) ? fm.triggers.filter((t: unknown) => typeof t === 'string') : undefined;

    const extraMetadata = canonicalName ? { source_canonical: canonicalName } : undefined;

    // serializeSkillMarkdown 只认固定字段；provenance 用正文顶部注释保留，避免信息丢失。
    const base = serializeSkillMarkdown({
        name,
        displayName,
        description,
        triggers,
        extraMetadata,
        systemPrompt: body
    });

    const provenance: string[] = [];
    if (rawSlug) provenance.push(`source: SkillHub`);
    if (fm.slug) provenance.push(`source_slug: ${String(fm.slug)}`);
    if (fm.version) provenance.push(`source_version: ${String(fm.version)}`);
    if (fm.author) provenance.push(`source_author: ${String(fm.author)}`);
    if (fm.license) provenance.push(`source_license: ${String(fm.license)}`);
    if (!provenance.length) return base;

    // 把 provenance 作为 HTML 注释插到正文开头（不影响 systemPrompt 语义，保留署名与来源）。
    const marker = `<!-- ${provenance.join(' | ')} -->`;
    return base.replace(/\n---\n\n/, `\n---\n\n${marker}\n\n`);
}
