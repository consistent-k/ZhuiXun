import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

import { writeJsonAtomic } from '@/config/atomic-json';

import { parseSkillMarkdownString, serializeSkillMarkdown, type SkillUpsertInput } from './loader';

/**
 * 用户技能目录的写盘层。
 *
 * 职责单一：把「用户技能」落到可写用户目录（见 app.ts 的 userSkillsDir），并做好 id 校验与
 * 路径穿越防护。不碰只读的内置技能目录。序列化交给 loader.serializeSkillMarkdown，扫描/解析
 * 仍由 registry/loader 负责——本模块只做「写」与「删」。
 */

/** 技能 id 规则：kebab-case，作目录名，禁止路径分隔符与穿越 */
const SKILL_ID_RE = /^[a-z][a-z0-9-]*$/;

export function isValidSkillId(id: string): boolean {
    return SKILL_ID_RE.test(id);
}

/**
 * 解析并校验用户技能目录，确保落点在 userDir 之内（防 `../` 穿越）。
 * 校验失败抛错，调用方转成 4xx。
 */
export function resolveUserSkillDir(userDir: string, id: string): string {
    if (!isValidSkillId(id)) {
        throw new Error(`非法技能 id：${id}（仅支持小写字母、数字、连字符，且以字母开头）`);
    }
    const base = path.resolve(userDir);
    const target = path.resolve(base, id);
    // 归一后必须仍是 base 的直接子目录
    if (path.dirname(target) !== base) {
        throw new Error(`技能路径越界：${id}`);
    }
    return target;
}

export async function userSkillExists(userDir: string, id: string): Promise<boolean> {
    try {
        const dir = resolveUserSkillDir(userDir, id);
        const stat = await fs.stat(path.join(dir, 'SKILL.md'));
        return stat.isFile();
    } catch {
        return false;
    }
}

/**
 * 写入（新增或覆盖）一个用户技能：生成 SKILL.md 落到 <userDir>/<id>/SKILL.md。
 * 返回技能目录绝对路径，供 registry 重扫。
 */
export async function writeUserSkill(userDir: string, input: SkillUpsertInput): Promise<string> {
    const dir = resolveUserSkillDir(userDir, input.name);
    await fs.mkdir(dir, { recursive: true });

    const markdown = serializeSkillMarkdown(input);
    await fs.writeFile(path.join(dir, 'SKILL.md'), markdown, 'utf-8');

    return dir;
}

/** 删除用户技能目录（含 references 等资源）。目录不存在视为成功。 */
export async function deleteUserSkill(userDir: string, id: string): Promise<void> {
    const dir = resolveUserSkillDir(userDir, id);
    await fs.rm(dir, { recursive: true, force: true });
}

// ── 启用/停用状态 ──
// builtin 技能只读、无法把 disabled 写进其 SKILL.md，因此启用/停用统一存到用户目录的
// skills-state.json，对 builtin 与 user 一视同仁。

interface SkillsState {
    disabled: string[];
}

const STATE_FILE = 'skills-state.json';

export async function readSkillsState(userDir: string): Promise<SkillsState> {
    try {
        const raw = await fs.readFile(path.join(userDir, STATE_FILE), 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            disabled: Array.isArray(parsed?.disabled)
                ? parsed.disabled.filter((x: unknown) => typeof x === 'string')
                : []
        };
    } catch {
        return { disabled: [] };
    }
}

export async function writeSkillsState(userDir: string, state: SkillsState): Promise<void> {
    // 原子写：先写临时文件再 rename，避免写入中途被终止导致 skills-state.json 截断，
    // 下次解析失败 → 停用状态丢失（被停用的技能被静默重新启用）。实现收在 platform/fs。
    await writeJsonAtomic(path.join(userDir, STATE_FILE), state);
}

// ── 技能包上传 / 导入 / 导出 ──

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件 2MB
const MAX_TOTAL_BYTES = 15 * 1024 * 1024; // 单包 15MB
const MAX_FILES = 300;
/**
 * 允许随技能包分发的资源子目录。
 * 注意：`tools/` **永不**在此列——它的 `tools/index.js` 在技能加载时会被 `import()` 自动执行（见
 * loader.discoverTools），对不可信技能等于加载即执行代码。`scripts/` 不同：仅随技能落盘、不被自动
 * 执行，只有经用户审批的 Bash 调用才可能跑它，故 SkillHub 市场安装按 D5 决策把 `scripts/` 加入白名单。
 */
const ALLOWED_RESOURCE_DIRS = ['references/', 'examples/'];

/** 从 SKILL.md 文本解析出并校验技能 id，失败抛错。 */
function skillIdFromMarkdown(md: string): string {
    const { frontmatter } = parseSkillMarkdownString(md);
    const id = (frontmatter.name || '').trim();
    if (!id) throw new Error('SKILL.md frontmatter 缺少 name');
    if (!isValidSkillId(id)) throw new Error(`SKILL.md 的 name 非法：${id}`);
    return id;
}

/** 导入单个 .md：内容即 SKILL.md，解析出 id 后落盘。返回技能 id。 */
export async function importSkillFromMarkdown(userDir: string, markdown: string): Promise<string> {
    const id = skillIdFromMarkdown(markdown);
    const dir = resolveUserSkillDir(userDir, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), markdown, 'utf-8');
    return id;
}

/**
 * 导入 .zip 技能包：解出 SKILL.md（根或单层目录下）+ references/examples 资源，落到 <userDir>/<id>/。
 * 安全：忽略 tools/ 与其它目录；拒绝 `..` 路径穿越；限制文件数与体积。返回技能 id。
 *
 * @param opts.rewriteSkillMd 可选：对解出的 SKILL.md 文本先做一次改写再解析 id（SkillHub 市场安装用，
 *   把 `slug`→`name` 等归一为 zhuixun frontmatter 形态）。普通上传不传此项，行为不变。
 * @param opts.allowedResourceDirs 可选：覆盖默认资源白名单（默认 references/ examples/）。普通上传用。
 * @param opts.blockedResourceDirs 可选：denylist 模式。提供时忽略 allowedResourceDirs，改为「保留除这些
 *   顶层目录外的全部文件」（SkillHub 市场安装用，传 `['tools/']`）。目的是不丢失 hooks/README/FAQ 等被
 *   SKILL.md 实际引用、却不在旧白名单内的内容。**务必**把会「加载即执行」的目录（`tools/`，见
 *   ALLOWED_RESOURCE_DIRS 注释）列入其中；隐藏项（任一路径段以 `.` 开头，如 .git/.DS_Store）一律跳过。
 *
 * 落盘用「临时暂存目录 + 原子 rename」而非「先 rm 旧目录再写」：覆盖重装若中途失败，旧技能仍完整，
 * 不会被半截写入污染或丢失。
 */
export async function importSkillFromZip(
    userDir: string,
    zipBuffer: Uint8Array,
    opts: {
        rewriteSkillMd?: (markdown: string) => string;
        allowedResourceDirs?: string[];
        blockedResourceDirs?: string[];
    } = {}
): Promise<string> {
    const allowedDirs = opts.allowedResourceDirs ?? ALLOWED_RESOURCE_DIRS;
    const blockedDirs = opts.blockedResourceDirs;
    // fflate 的 filter 在解压前收到中央目录大小；先只读元信息，避免 ZIP 炸弹在校验前分配内存。
    // 仅对最终保留的资源解压，保持白名单外文件被忽略的既有语义。
    const sizes = new Map<string, number>();
    unzipSync(zipBuffer, {
        filter: ({ name, originalSize }) => {
            // ZIP 统一用 POSIX 相对路径；提前拒绝 Windows 分隔符/盘符与路径别名，
            // 否则在 Windows 解压时会把反斜线或盘符解释成真实路径，绕过资源目录筛选。
            if (
                name.includes('..') ||
                name.includes('\\') ||
                name.includes(':') ||
                name.includes('\0') ||
                name.startsWith('/') ||
                name.split('/').includes('.')
            ) {
                throw new Error(`技能包含非法路径：${name}`);
            }
            sizes.set(name, originalSize);
            return false;
        }
    });
    const names = [...sizes.keys()];

    // 找 SKILL.md：根 `SKILL.md` 或单层目录 `<x>/SKILL.md`，取路径最短的那个
    const isSkillMd = (n: string) => /(^|\/)SKILL\.md$/.test(n);
    const skillMdPath = names
        .filter((n) => isSkillMd(n) && !n.includes('..'))
        .sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (!skillMdPath) throw new Error('技能包缺少 SKILL.md');

    const base = skillMdPath.slice(0, skillMdPath.length - 'SKILL.md'.length); // 含末尾 `/` 或空
    // SKILL.md 也是单文件；旧实现只限制资源，正文可绕过 2MB 限制。
    if (sizes.get(skillMdPath)! > MAX_FILE_BYTES) throw new Error('技能包文件过大：SKILL.md');
    let markdown = strFromU8(unzipSync(zipBuffer, { filter: ({ name }) => name === skillMdPath })[skillMdPath]);
    if (opts.rewriteSkillMd) markdown = opts.rewriteSkillMd(markdown);
    const markdownBytes = strToU8(markdown);
    if (markdownBytes.length > MAX_FILE_BYTES) throw new Error('技能包文件过大：SKILL.md');
    const id = skillIdFromMarkdown(markdown);

    // 收集资源，做安全与体积校验。
    // - denylist 模式（blockedResourceDirs）：保留除危险目录（加载即执行的 tools/）外的全部文件，跳过隐藏项；
    // - allowlist 模式（默认）：仅保留白名单资源目录（references/ examples/）。
    const isHiddenPath = (rel: string) => rel.split('/').some((seg) => seg.startsWith('.'));
    const keepResource = (rel: string): boolean => {
        // tools/index.js 会在 loader 加载时执行；不可信上传必须硬拒绝，不能被可选策略放行。
        // macOS/Windows 常用大小写不敏感文件系统；Windows 还会折叠目录名末尾的点/空格。
        const topDir = rel
            .split('/')[0]
            .replace(/[. ]+$/, '')
            .toLowerCase();
        if (topDir === 'tools') return false;
        if (blockedDirs) {
            if (isHiddenPath(rel)) return false; // 跳过 .git/.DS_Store 等隐藏项
            return !blockedDirs.some((d) => rel === d.replace(/\/+$/, '') || rel.startsWith(d));
        }
        return allowedDirs.some((d) => rel.startsWith(d));
    };

    const resources: Array<{ name: string; rel: string }> = [];
    let total = markdownBytes.length;
    for (const name of names) {
        if (name === skillMdPath) continue;
        if (name.endsWith('/')) continue; // 目录项
        if (name.includes('..')) throw new Error(`技能包含非法路径：${name}`);
        if (base && !name.startsWith(base)) continue; // 单层目录外的项忽略
        const rel = base ? name.slice(base.length) : name;
        if (!keepResource(rel)) continue; // 按模式筛选资源
        const size = sizes.get(name)!;
        if (size > MAX_FILE_BYTES) throw new Error(`技能包文件过大：${rel}`);
        total += size;
        resources.push({ name, rel });
    }
    if (resources.length + 1 > MAX_FILES) throw new Error('技能包文件数超限');
    if (total > MAX_TOTAL_BYTES) throw new Error('技能包体积超限');
    const selected = new Set(resources.map(({ name }) => name));
    const entries = unzipSync(zipBuffer, { filter: ({ name }) => selected.has(name) });

    const dir = resolveUserSkillDir(userDir, id);
    // 原子落盘：先写进同目录下的临时暂存目录，整体写成功后再 rm 旧目录 + rename 顶替。
    // 中途失败则清掉暂存目录、旧技能保持原样（覆盖重装不会丢旧技能）。
    await fs.mkdir(userDir, { recursive: true });
    const staging = await fs.mkdtemp(path.join(userDir, `.tmp-${id}-`));
    try {
        await fs.writeFile(path.join(staging, 'SKILL.md'), markdownBytes);
        for (const { name, rel } of resources) {
            const dest = path.join(staging, rel);
            // 二次防线：归一后必须仍在暂存目录内
            if (!path.resolve(dest).startsWith(path.resolve(staging) + path.sep)) {
                throw new Error(`资源路径越界：${rel}`);
            }
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.writeFile(dest, entries[name]);
        }
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(staging, dir);
    } catch (err) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        throw err;
    }
    return id;
}

/** 把技能目录（SKILL.md + references/examples）打成 zip，返回字节。 */
export async function exportSkillToZip(dirPath: string): Promise<Uint8Array> {
    const files: Record<string, Uint8Array> = {};

    const skillMd = await fs.readFile(path.join(dirPath, 'SKILL.md'), 'utf-8');
    files['SKILL.md'] = strToU8(skillMd);

    for (const sub of ALLOWED_RESOURCE_DIRS) {
        const subDir = path.join(dirPath, sub);
        let dirents: Dirent[] | undefined;
        try {
            // engines 要求 Node >= 24，readdir 原生支持 recursive + withFileTypes（返回 Dirent[]），
            // 无需再用 as any 掩盖类型
            dirents = await fs.readdir(subDir, { withFileTypes: true, recursive: true });
        } catch {
            continue;
        }
        for (const d of dirents ?? []) {
            if (!d.isFile?.()) continue;
            const abs = path.join(d.parentPath || subDir, d.name);
            const rel = path.relative(dirPath, abs).split(path.sep).join('/');
            files[rel] = new Uint8Array(await fs.readFile(abs));
        }
    }

    return zipSync(files);
}
