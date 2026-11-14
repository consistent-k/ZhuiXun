import { unzipSync, strFromU8 } from 'fflate';

import { createLogger } from '@/platform/logging/index';

import { parseSkillMarkdownString } from '../loader';
import type { SkillRegistry } from '../registry';

import { downloadSkillZip, sanitizeSlug, type SkillHubClientConfig } from './client';
import { normalizeSkillHubSkillMd } from './mapper';
import type { MarketInstallResult } from './types';

const log = createLogger('SkillHubInstaller');

/**
 * 落盘时**剥离**的危险顶层目录。按威胁模型，唯一需要剥离的是会「加载即执行」的 `tools/`
 * （其 `tools/index.js` 在技能加载时被 loader.discoverTools 的 `import()` 自动执行）。其余目录
 * （references/ examples/ scripts/ hooks/ 及 README/FAQ 等根文件）均为惰性数据，只有经用户审批的
 * Bash 调用才可能跑它们，故全部保留——避免像旧白名单那样丢失 SKILL.md 实际引用的 hooks/README/FAQ。
 */
const STRIPPED = ['tools/'];

/** 定位 SKILL.md（根或单层目录），返回 { base, skillMdPath }。 */
function locateSkillMd(names: string[]): { base: string; skillMdPath: string } | null {
    const isSkillMd = (n: string) => /(^|\/)SKILL\.md$/.test(n);
    const skillMdPath = names
        .filter((n) => isSkillMd(n) && !n.includes('..'))
        .sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (!skillMdPath) return null;
    return { base: skillMdPath.slice(0, skillMdPath.length - 'SKILL.md'.length), skillMdPath };
}

/**
 * 安装一个 SkillHub 市场技能到本地技能目录。
 *
 * 流程：下载 zip（跟随 302→COS）→ 读取源版本 →
 * 交 registry.importSkill('zip', buf, { rewriteSkillMd, blockedResourceDirs }) 归一化落盘
 * （slug→name、原子 rename、保留除 tools/ 外的全部内容——references/examples/scripts/hooks/README/FAQ 等
 * 都随技能落盘，仅 tools/ 这种加载即执行的目录被剔除）。
 *
 * 注：scripts/、hooks/ 等保留但不自动执行，执行侧已有 Bash 审批把关，故安装不额外提示用户。
 */
export async function installMarketSkill(
    registry: SkillRegistry,
    cfg: SkillHubClientConfig,
    slugInput: string,
    version?: string,
    signal?: AbortSignal,
    canonicalName?: string,
    displayName?: string
): Promise<MarketInstallResult> {
    const slug = sanitizeSlug(slugInput);
    // canonicalName（`@namespace/slug`）用于：① 下载消歧（同 slug 跨 namespace 时精确命中正确技能）；
    // ② 写入 metadata.source_canonical，供「已安装」精确比对。缺省时退化为按 slug 下载 namespace 默认技能。
    const canonical = String(canonicalName ?? '').trim();
    const display = String(displayName ?? '').trim();
    const buf = await downloadSkillZip(cfg, slug, version, signal, canonical);

    // 读取源版本用于回传（探测失败不致命，不影响安装）。
    let srcVersion = '';
    try {
        const entries = unzipSync(buf);
        const located = locateSkillMd(Object.keys(entries));
        if (located) {
            const fm = parseSkillMarkdownString(strFromU8(entries[located.skillMdPath]))
                .frontmatter as unknown as Record<string, unknown>;
            srcVersion = String(fm.version || '').trim();
        }
    } catch (err) {
        log.warn('安装前读取源版本失败（不影响安装）', { slug, err });
    }

    const id = await registry.importSkill('zip', buf, {
        rewriteSkillMd: (md: string) =>
            normalizeSkillHubSkillMd(md, { canonicalName: canonical, displayName: display }),
        blockedResourceDirs: STRIPPED
    });
    log.info('SkillHub 技能已安装', { slug, id, canonical });

    return { id, slug, version: srcVersion || sanitizeVersionSafe(version), canonicalName: canonical || undefined };
}

function sanitizeVersionSafe(v?: string): string {
    return String(v ?? '').trim();
}
