import fs from 'node:fs/promises';
import path from 'node:path';

import { MCPToolAdapter } from '@/modules/mcp';
import { MCPToolDiscovery } from '@/modules/mcp';
import type { MCPClientManager } from '@/modules/mcp';
import { createLogger } from '@/platform/logging/index';

import { loadSkillFromDirectory, parseSkillFrontmatter, formatSkillCatalog, readSkillSource } from './loader';
import type { LoadedSkill, SkillMetadata, SkillUpsertInput } from './loader';
import * as store from './store';

const log = createLogger('SkillRegistry');

export class SkillRegistry {
    private metadata = new Map<string, SkillMetadata>();
    private skills = new Map<string, LoadedSkill>();
    private mcpAdapter: MCPToolAdapter;
    private userDir: string;
    // 额外的只读技能根（如 ~/.agents）——兼容市面大多数 Agent 的跨工具技能约定。
    // 这些目录里的技能标记为 source='builtin'、editable=false：可启停，但不可经 CRUD 编辑/删除。
    private externalDirs: string[];
    private loadingPromises = new Map<string, Promise<LoadedSkill | undefined>>();
    // 启用/停用是 read-modify-write（读 skills-state.json → 改集合 → 写回 + reload），
    // 并发切换会互相覆盖丢更新。用一条 promise 链串行化，保证每次切换基于最新落盘状态。
    private toggleQueue: Promise<unknown> = Promise.resolve();

    constructor(mcpManager: MCPClientManager, userDir: string, externalDirs: string[] = []) {
        this.mcpAdapter = new MCPToolAdapter(mcpManager);
        this.userDir = userDir;
        // 去重并剔除与 userDir 相同的根，避免同一目录被扫两遍 / 被误判为只读。
        const userResolved = path.resolve(userDir);
        const seen = new Set<string>();
        this.externalDirs = externalDirs
            .map((dir) => path.resolve(dir))
            .filter((dir) => {
                if (dir === userResolved || seen.has(dir)) return false;
                seen.add(dir);
                return true;
            });
    }

    /**
     * shell 工具的技能资源来源目录（可写用户目录）。
     *
     * shell 工具需要它作为「上传哪些参考文档到工作目录」的来源。这里只返回可写的用户目录：
     * 种子进来的技能（及用户自建技能）的 references/*.md 会被上传。外部只读根（~/.agents）的
     * 参考资源暂不随此上传——它们主要用于技能发现与路由，需要时再单独扩展。
     *
     * 仍必须由 app.ts 传入而非在别处用 `import.meta.url` 推导——dev（src）与打包（app.js）
     * 两形态下 __dirname 含义不同，同一行相对路径会指向不同地方。
     */
    getSkillsDir(): string {
        return this.userDir;
    }

    /**
     * 扫描一个技能根目录，把发现的技能写入 metadata。
     *
     * @param source   'user'（可写用户目录）或 'builtin'（外部只读根，如 ~/.agents）
     * @param editable 仅 source==='user' 为 true；只读根发现的技能禁止 CRUD 编辑/删除
     *
     * 同 id 冲突时按调用顺序「后扫覆盖先扫」：scan() 先扫外部只读根、最后扫 userDir，
     * 因此用户自己在 userDir 里的同名技能会覆盖外部同名技能（用户自建优先）。
     */
    private async scanRoot(rootDir: string, source: SkillMetadata['source'], editable: boolean): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(rootDir, { withFileTypes: true });
        } catch {
            // 目录不存在（如用户还没建过技能、或没有 ~/.agents）时静默跳过
            return;
        }

        for (const entry of entries) {
            // 支持目录，以及「指向目录的符号链接」（外部根里常见，如 ~/.agents/skills/ego-browser 软链）。
            let isDir = entry.isDirectory();
            if (!isDir && entry.isSymbolicLink()) {
                try {
                    isDir = (await fs.stat(path.join(rootDir, entry.name))).isDirectory();
                } catch {
                    isDir = false;
                }
            }
            if (!isDir) continue;

            const skillDir = path.join(rootDir, entry.name);
            // 没有 SKILL.md 的子目录不是技能——外部只读根（如 ~/.agents）里常混有 skills 以外的目录，
            // 这里静默跳过，不走 parseSkillFrontmatter 的 error 日志（那条日志是给「SKILL.md 存在但
            // 格式写错」的确实格式错误的技能用的，不该被「这本就不是技能目录」污染）。
            try {
                await fs.access(path.join(skillDir, 'SKILL.md'));
            } catch {
                continue;
            }

            const frontmatter = await parseSkillFrontmatter(skillDir);
            if (!frontmatter) continue;

            const id = frontmatter.name || entry.name;
            this.metadata.set(id, {
                id,
                // 展示名：优先取 metadata.display_name（中文），否则退回 id
                name: frontmatter.metadata?.display_name || id,
                description: frontmatter.description || '',
                dirPath: skillDir,
                loaded: false,
                triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers : undefined,
                source,
                editable,
                disabled: false,
                sourceCanonical: frontmatter.metadata?.source_canonical || undefined
            });

            log.info('发现技能', { skillId: id, source, rootDir });
        }
    }

    /**
     * 扫描所有技能根目录，重建 metadata。
     *
     * 根顺序：先扫外部只读根（~/.agents 等，source='builtin'），最后扫 userDir（source='user'），
     * 保证 id 冲突时用户自建技能覆盖外部同名技能。每次调用都从空开始重建，因此也能反映删除。
     */
    async scan(): Promise<void> {
        this.metadata.clear();
        for (const dir of this.externalDirs) {
            await this.scanRoot(dir, 'builtin', false);
        }
        await this.scanRoot(this.userDir, 'user', true);
        // 应用启用/停用状态（统一存于用户目录的 skills-state.json，对 builtin/user 一视同仁）
        const state = await store.readSkillsState(this.userDir);
        const disabled = new Set(state.disabled);
        for (const meta of this.metadata.values()) {
            meta.disabled = disabled.has(meta.id);
        }
    }

    async load(id: string): Promise<LoadedSkill | undefined> {
        if (this.skills.has(id)) return this.skills.get(id);

        if (this.loadingPromises.has(id)) return this.loadingPromises.get(id);

        const meta = this.metadata.get(id);
        if (!meta) return undefined;

        const promise = loadSkillFromDirectory(meta.dirPath, this.mcpAdapter)
            .then((skill) => {
                this.skills.set(id, skill);
                meta.loaded = true;
                return skill;
            })
            .catch((error) => {
                log.error('技能加载失败', { skillId: id, err: error });
                return undefined;
            })
            .finally(() => {
                this.loadingPromises.delete(id);
            });

        this.loadingPromises.set(id, promise);
        return promise;
    }

    async get(id: string): Promise<LoadedSkill | undefined> {
        return this.load(id);
    }

    listMetadata(): SkillMetadata[] {
        return Array.from(this.metadata.values());
    }

    getMetadataById(id: string): SkillMetadata | undefined {
        return this.metadata.get(id);
    }

    /** 按需列出技能资源，不读取正文或跟随资源软链；路径相对于实际技能目录（含共享根与用户覆盖）。 */
    async listResourceFiles(id: string): Promise<string[]> {
        const meta = this.metadata.get(id);
        if (!meta || meta.disabled) return [];
        const entries = await fs.readdir(meta.dirPath, { recursive: true, withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile())
            .map((entry) =>
                path.relative(meta.dirPath, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
            )
            .filter((file) => file !== 'SKILL.md')
            .sort();
    }

    /** 是否配置了可写用户目录（未配置时写接口一律拒绝） */
    hasUserDir(): boolean {
        return !!this.userDir;
    }

    /** 读取技能源字段用于前端编辑回填（含 systemPrompt 原文、triggers 等）。 */
    async getSkillSource(id: string): Promise<SkillUpsertInput | undefined> {
        const meta = this.metadata.get(id);
        if (!meta) return undefined;
        return readSkillSource(meta.dirPath);
    }

    /**
     * 写盘后重建：清空已加载技能缓存 + 重扫。
     * 技能是懒加载的，清缓存后下次 get/loadAll 会按新内容重新解析，代价仅一次 SKILL.md 解析。
     */
    private async reload(): Promise<void> {
        this.skills.clear();
        this.loadingPromises.clear();
        await this.scan();
    }

    /** 新增用户技能。id 已存在同源用户技能时冲突（覆盖内置是允许的）。 */
    async createUserSkill(input: SkillUpsertInput): Promise<SkillMetadata> {
        if (!this.userDir) throw new Error('未配置用户技能目录，无法新增');
        if (await store.userSkillExists(this.userDir, input.name)) {
            const err = new Error(`技能 "${input.name}" 已存在`);
            (err as Error & { code?: string }).code = 'CONFLICT';
            throw err;
        }
        await store.writeUserSkill(this.userDir, input);
        await this.reload();
        return this.metadata.get(input.name)!;
    }

    /** 编辑用户技能。仅 source==='user' 可改；不支持改 id（表单已禁用 name 编辑）。 */
    async updateUserSkill(id: string, input: SkillUpsertInput): Promise<SkillMetadata> {
        if (!this.userDir) throw new Error('未配置用户技能目录，无法编辑');
        const meta = this.metadata.get(id);
        if (!meta) {
            const err = new Error(`技能 "${id}" 不存在`);
            (err as Error & { code?: string }).code = 'NOT_FOUND';
            throw err;
        }
        if (meta.source !== 'user') {
            const err = new Error(`内置技能 "${id}" 只读，不可编辑`);
            (err as Error & { code?: string }).code = 'FORBIDDEN';
            throw err;
        }
        // 强制 id 一致，避免通过 body.name 改名导致目录漂移
        await store.writeUserSkill(this.userDir, { ...input, name: id });
        await this.reload();
        return this.metadata.get(id)!;
    }

    /** 删除用户技能。仅 source==='user' 可删（删除后若内置有同 id 会自动回退）。 */
    async removeUserSkill(id: string): Promise<void> {
        if (!this.userDir) throw new Error('未配置用户技能目录，无法删除');
        const meta = this.metadata.get(id);
        if (!meta) {
            const err = new Error(`技能 "${id}" 不存在`);
            (err as Error & { code?: string }).code = 'NOT_FOUND';
            throw err;
        }
        if (meta.source !== 'user') {
            const err = new Error(`内置技能 "${id}" 只读，不可删除`);
            (err as Error & { code?: string }).code = 'FORBIDDEN';
            throw err;
        }
        await store.deleteUserSkill(this.userDir, id);
        await this.reload();
    }

    /** 启用/停用技能（builtin/user 均可）。返回切换后的 disabled 值。 */
    async toggleSkill(id: string): Promise<boolean> {
        if (!this.userDir) throw new Error('未配置用户技能目录，无法切换状态');
        const meta = this.metadata.get(id);
        if (!meta) {
            const err = new Error(`技能 "${id}" 不存在`);
            (err as Error & { code?: string }).code = 'NOT_FOUND';
            throw err;
        }
        // 读-改-写-重扫整段串行化，避免并发切换丢更新
        const userDir = this.userDir;
        const run = this.toggleQueue.then(async () => {
            const state = await store.readSkillsState(userDir);
            const set = new Set(state.disabled);
            const nextDisabled = !set.has(id);
            if (nextDisabled) set.add(id);
            else set.delete(id);
            await store.writeSkillsState(userDir, { disabled: [...set] });
            await this.reload();
            return nextDisabled;
        });
        this.toggleQueue = run.catch(() => undefined);
        return run;
    }

    /**
     * 导入技能包（.md 文本或 .zip 字节），落到用户目录并重扫。返回技能 id。
     *
     * @param opts.rewriteSkillMd 仅 zip 生效：落盘前对 SKILL.md 文本改写（SkillHub 市场安装把
     *   `slug`→`name` 等归一为 zhuixun frontmatter 形态）。
     * @param opts.allowedResourceDirs 仅 zip 生效：覆盖资源白名单（普通上传用，默认 references/ examples/）。
     * @param opts.blockedResourceDirs 仅 zip 生效：denylist 模式，保留除这些目录外的全部文件（SkillHub 市场
     *   安装传 `['tools/']`，避免丢失 hooks/README/FAQ 等被 SKILL.md 引用的内容）。
     */
    async importSkill(
        kind: 'md' | 'zip',
        payload: string | Uint8Array,
        opts: {
            rewriteSkillMd?: (markdown: string) => string;
            allowedResourceDirs?: string[];
            blockedResourceDirs?: string[];
        } = {}
    ): Promise<string> {
        if (!this.userDir) throw new Error('未配置用户技能目录，无法导入');
        const id =
            kind === 'md'
                ? await store.importSkillFromMarkdown(this.userDir, payload as string)
                : await store.importSkillFromZip(this.userDir, payload as Uint8Array, opts);
        await this.reload();
        return id;
    }

    /** 导出技能为 zip 字节（builtin/user 均可导出）。 */
    async exportSkill(id: string): Promise<Uint8Array> {
        const meta = this.metadata.get(id);
        if (!meta) {
            const err = new Error(`技能 "${id}" 不存在`);
            (err as Error & { code?: string }).code = 'NOT_FOUND';
            throw err;
        }
        return store.exportSkillToZip(meta.dirPath);
    }

    listLoaded(): LoadedSkill[] {
        return Array.from(this.skills.values());
    }

    getCatalog(): string {
        // 停用的技能不进 catalog（模型看不到、不会被路由到）
        return formatSkillCatalog(Array.from(this.metadata.values()).filter((s) => !s.disabled));
    }

    getEnabledMetadata(): SkillMetadata[] {
        return Array.from(this.metadata.values()).filter((s) => !s.disabled);
    }

    /**
     * shell 工具 seed 技能参考文档时用到的「userDir 下技能子目录名」清单，按启用/停用分组。
     *
     * - 只含 source==='user'（即 userDir 下）的技能：shell 的 uploadDirectory.source 就是
     *   getSkillsDir()（userDir），外部只读根（~/.agents）的技能本就不随此上传。
     * - 用**物理目录名**（basename(dirPath)）而非技能 id：uploadDirectory 的 include 是按磁盘
     *   目录匹配的，id 可能与目录名不一致（id 取 frontmatter.name）。
     * - enabled：把 uploadDirectory.include 收窄到「只 seed 启用技能」，避免停用技能的 .md
     *   出现在 bash 工具描述的 "Available files" 清单里被模型当成可用技能。
     * - disabled：清掉 workspace（持久 tmp 目录）里历史 session 残留的停用技能目录，
     *   否则模型 `ls` 仍能看到已停用技能，等于绕过前端「停用」。
     */
    getUserSkillDirNames(): { enabled: string[]; disabled: string[] } {
        const enabled: string[] = [];
        const disabled: string[] = [];
        for (const meta of this.metadata.values()) {
            if (meta.source !== 'user') continue;
            const dirName = path.basename(meta.dirPath);
            (meta.disabled ? disabled : enabled).push(dirName);
        }
        return { enabled, disabled };
    }

    async loadAll(): Promise<LoadedSkill[]> {
        const results: LoadedSkill[] = [];
        for (const id of this.metadata.keys()) {
            const skill = await this.load(id);
            if (skill) results.push(skill);
        }
        return results;
    }

    /** 只加载未停用的技能，供 agent 组装工具集时使用（停用的技能其工具不挂载）。 */
    async loadEnabled(): Promise<LoadedSkill[]> {
        const results: LoadedSkill[] = [];
        for (const [id, meta] of this.metadata.entries()) {
            if (meta.disabled) continue;
            const skill = await this.load(id);
            if (skill) results.push(skill);
        }
        return results;
    }

    /** 获取 MCP 适配器实例 */
    getMCPAdapter(): MCPToolAdapter {
        return this.mcpAdapter;
    }

    /** 获取 MCP 发现实例 */
    getMCPDiscovery(): MCPToolDiscovery {
        return new MCPToolDiscovery(this.mcpAdapter);
    }
}
