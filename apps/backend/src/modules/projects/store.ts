import fs from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic as writeFileAtomicImpl } from '@/config/atomic-json';
import { paths } from '@/config/paths';
import { isValidId } from '@/platform/fs/id';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('Projects');

/** 序列化版本，便于后续演进项目文件结构 */
const CURRENT_VERSION = 1;

/** 项目指令注入系统提示词的字符预算，超出截断，保护上下文（与记忆一致的策略） */
export const PROJECT_INSTRUCTIONS_BUDGET = 4000;

/** 项目根目录：一个项目可挂多个本地目录，其一为 primary（即会话 shell 的 cwd）。 */
export interface ProjectRoot {
    /** 绝对路径 */
    path: string;
    /** 是否主根（有且仅一个）；缺省视为非主根 */
    primary?: boolean;
}

/**
 * 项目全量（落盘为 `projects/<id>/project.json`）。
 * 项目是「用户手动创建的逻辑分组」；可选挂载多个本地根目录，会话通过自身的 projectId 归属到项目。
 */
export interface SavedProject {
    version: number;
    id: string;
    name: string;
    /** 展示用图标（emoji 或 antd icon key） */
    icon?: string;
    /** 展示用颜色 */
    color?: string;
    /** 是否归档（归档项目默认折叠、不参与新建默认归属） */
    archived?: boolean;
    /** 项目级指令：该项目内所有会话的 systemPrompt 都会 push 这段（P0） */
    instructions?: string;
    /** 新会话默认技能 id（P1） */
    defaultSkillId?: string;
    /** 路由模式下限定启用的技能 id 集合；为空表示不限定（P1） */
    skillPreset?: string[];
    /** 项目工作目录集合：primary 根作为会话 Bash/Read/Write 的 cwd，其余为附加根（均绝对路径） */
    roots?: ProjectRoot[];
    /** 是否信任本项目目录：开启后其任一根范围内的安全命令/写入在对话时自动放行（默认关闭） */
    trusted?: boolean;
    /** 软删除标记：true 时不出现在默认列表，可恢复或彻底删除 */
    deleted?: boolean;
    /** 软删除时间戳（ms） */
    deletedAt?: number;
    createdAt: number;
    updatedAt: number;
}

/** 项目列表元信息（不含 instructions 等重字段，供侧栏秒开，落在 `index.json`） */
export interface ProjectMeta {
    id: string;
    name: string;
    icon?: string;
    color?: string;
    archived?: boolean;
    /** 工作目录集合（含 primary 标记，供侧栏展示文件夹标记与数量） */
    roots?: ProjectRoot[];
    /** 是否信任（供侧栏/设置展示信任态） */
    trusted?: boolean;
    /** 软删除标记（默认列表已过滤；回收站用 includeDeleted 拉取） */
    deleted?: boolean;
    deletedAt?: number;
    createdAt: number;
    updatedAt: number;
}

/** 创建/更新项目入参（updatedAt 由服务端赋值） */
export interface ProjectUpsert {
    name: string;
    icon?: string;
    color?: string;
    archived?: boolean;
    instructions?: string;
    defaultSkillId?: string;
    skillPreset?: string[];
    /** 工作目录集合；传入即整体覆盖（含 primary）。缺省沿用旧值 */
    roots?: ProjectRoot[];
    /** 是否信任本项目目录；缺省沿用旧值 */
    trusted?: boolean;
    /** 仅创建时使用；缺省时沿用已存在值或取当前时间 */
    createdAt?: number;
}

/**
 * 仅允许安全字符的 id：id 会拼进目录名，必须杜绝路径穿越（如 `../`）。
 * 与会话 id 校验规则一致（前端用 crypto.randomUUID() 生成）。
 */
export function isValidProjectId(id: string): boolean {
    return isValidId(id);
}

/**
 * 项目根目录：与技能/记忆/会话同源，落在用户可写目录 `~/.zhuixun/projects/`，不写进代码库。
 * 可用 env `PROJECTS_USER_DIR` 覆盖（与 `SKILLS_USER_DIR` / `SESSIONS_USER_DIR` 对齐）。
 * 基于 os.homedir()，dev（tsx 跑 src）与打包（app.js 在只读 resources）两形态指向同一用户目录。
 */
function resolveProjectsDir(): string {
    return paths.projectsDir();
}

/** 读取时归一根集合：过滤非法项，保证至多一个 primary。 */
export function normalizeRoots(project: Pick<SavedProject, 'roots'>): ProjectRoot[] {
    const roots = Array.isArray(project.roots)
        ? project.roots.filter((r): r is ProjectRoot => !!r && typeof r.path === 'string' && !!r.path)
        : [];
    if (roots.length === 0) return [];
    // 保证有且仅有一个 primary：有显式 primary 取第一个命中，否则第一个根为 primary
    const primaryIdx = roots.findIndex((r) => r.primary);
    const idx = primaryIdx >= 0 ? primaryIdx : 0;
    return roots.map((r, i) => ({ path: r.path, primary: i === idx }));
}

/** 主根路径（会话 shell cwd）；无根返回 undefined。 */
export function primaryRootPath(project: Pick<SavedProject, 'roots'>): string | undefined {
    return normalizeRoots(project).find((r) => r.primary)?.path;
}

/** 全部根路径（primary 在前）。 */
export function allRootPaths(project: Pick<SavedProject, 'roots'>): string[] {
    const roots = normalizeRoots(project);
    const primary = roots.find((r) => r.primary)?.path;
    const rest = roots.filter((r) => !r.primary).map((r) => r.path);
    return [primary, ...rest].filter((p): p is string => !!p);
}

function toMeta(project: SavedProject): ProjectMeta {
    return {
        id: project.id,
        name: project.name,
        icon: project.icon,
        color: project.color,
        archived: project.archived,
        roots: normalizeRoots(project),
        trusted: project.trusted,
        deleted: project.deleted,
        deletedAt: project.deletedAt,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
    };
}

/** 列表按最近更新倒序，与侧栏展示一致 */
function sortMetas(metas: ProjectMeta[]): ProjectMeta[] {
    return [...metas].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 项目仓储：每项目一个目录 `projects/<id>/`（含 `project.json`）
 * + 一份根 `index.json` 元信息索引。写操作走串行队列 + 原子写（临时文件 rename），
 * 范式与 `features/conversations/store.ts` 一致。
 */
export class ProjectStore {
    private readonly dir: string;
    private readonly indexPath: string;
    private indexCache: ProjectMeta[] | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(dir = resolveProjectsDir()) {
        this.dir = dir;
        this.indexPath = path.join(dir, 'index.json');
    }

    private projectDir(id: string): string {
        return path.join(this.dir, id);
    }

    private projectPath(id: string): string {
        return path.join(this.projectDir(id), 'project.json');
    }

    private async loadIndex(): Promise<ProjectMeta[]> {
        if (this.indexCache) return this.indexCache;
        try {
            const raw = await fs.readFile(this.indexPath, 'utf8');
            this.indexCache = JSON.parse(raw) as ProjectMeta[];
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.error('索引读取/解析失败，扫描项目目录重建', { err });
            }
            // 首次运行、索引缺失或损坏：扫描 `<id>/project.json` 重建（不落盘，等下次写操作再持久化）
            this.indexCache = await this.rebuildIndex();
        }
        return this.indexCache;
    }

    /** 扫描目录重建索引；跳过非项目目录与解析失败的单个项目 */
    private async rebuildIndex(): Promise<ProjectMeta[]> {
        let entries;
        try {
            entries = await fs.readdir(this.dir, { withFileTypes: true });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw err;
        }
        const metas: ProjectMeta[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
                const raw = await fs.readFile(this.projectPath(entry.name), 'utf8');
                metas.push(toMeta(JSON.parse(raw) as SavedProject));
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    log.error('跳过损坏的项目文件', { dir: entry.name, err });
                }
            }
        }
        return sortMetas(metas);
    }

    /** 串行化写操作，保证项目文件与索引不交叉写入 */
    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** 原子写委托给 platform/fs（唯一实现）；并发串行化仍由本 store 的 enqueue 负责。 */
    private writeFileAtomic(filePath: string, content: string): Promise<void> {
        return writeFileAtomicImpl(filePath, content);
    }

    private async persistIndex(metas: ProjectMeta[]): Promise<void> {
        const next = sortMetas(metas);
        await this.writeFileAtomic(this.indexPath, JSON.stringify(next, null, 2));
        this.indexCache = next;
    }

    /** 项目列表（仅元信息，最近更新倒序）。默认过滤软删项目；includeDeleted 时返回全部（回收站用）。 */
    async list(opts?: { includeDeleted?: boolean }): Promise<ProjectMeta[]> {
        const all = sortMetas(await this.loadIndex());
        return opts?.includeDeleted ? all : all.filter((m) => !m.deleted);
    }

    /** 读取单个项目全量（roots 已归一）；不存在或 id 非法返回 null */
    async get(id: string): Promise<SavedProject | null> {
        if (!isValidProjectId(id)) return null;
        try {
            const raw = await fs.readFile(this.projectPath(id), 'utf8');
            const project = JSON.parse(raw) as SavedProject;
            return { ...project, roots: normalizeRoots(project) };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
        }
    }

    /** 幂等 upsert 整个项目（建/存均走这里），返回最新元信息 */
    async upsert(id: string, input: ProjectUpsert): Promise<ProjectMeta> {
        if (!isValidProjectId(id)) throw new Error('非法项目 id');
        return this.enqueue(async () => {
            const index = await this.loadIndex();
            const existing = await this.get(id);
            const roots = normalizeRoots({ roots: input.roots ?? existing?.roots });
            const project: SavedProject = {
                version: CURRENT_VERSION,
                id,
                name: input.name,
                icon: input.icon ?? existing?.icon,
                color: input.color ?? existing?.color,
                archived: input.archived ?? existing?.archived,
                instructions: input.instructions ?? existing?.instructions,
                defaultSkillId: input.defaultSkillId ?? existing?.defaultSkillId,
                skillPreset: input.skillPreset ?? existing?.skillPreset,
                // roots：显式传入即整体覆盖（传 [] 表示清空）；未传沿用旧值
                roots: roots.length > 0 ? roots : undefined,
                trusted: input.trusted ?? existing?.trusted,
                // 保留软删状态，避免 upsert 误复活/误删
                deleted: existing?.deleted,
                deletedAt: existing?.deletedAt,
                createdAt: existing?.createdAt || input.createdAt || Date.now(),
                updatedAt: Date.now()
            };
            await this.writeFileAtomic(this.projectPath(id), JSON.stringify(project, null, 2));
            const meta = toMeta(project);
            await this.persistIndex([...index.filter((m) => m.id !== id), meta]);
            return meta;
        });
    }

    /** 软删除：置 deleted 标记，保留项目目录与项目层记忆 memory/，可恢复。幂等。 */
    async softDelete(id: string): Promise<void> {
        if (!isValidProjectId(id)) return;
        await this.enqueue(async () => {
            const project = await this.get(id);
            if (!project) return;
            const next: SavedProject = { ...project, deleted: true, deletedAt: Date.now(), updatedAt: Date.now() };
            await this.writeFileAtomic(this.projectPath(id), JSON.stringify(next, null, 2));
            const index = await this.loadIndex();
            await this.persistIndex([...index.filter((m) => m.id !== id), toMeta(next)]);
        });
    }

    /** 恢复软删项目：清 deleted 标记。不存在返回 null。 */
    async restore(id: string): Promise<ProjectMeta | null> {
        if (!isValidProjectId(id)) return null;
        return this.enqueue(async () => {
            const project = await this.get(id);
            if (!project) return null;
            const next: SavedProject = { ...project, deleted: undefined, deletedAt: undefined, updatedAt: Date.now() };
            await this.writeFileAtomic(this.projectPath(id), JSON.stringify(next, null, 2));
            const index = await this.loadIndex();
            const meta = toMeta(next);
            await this.persistIndex([...index.filter((m) => m.id !== id), meta]);
            return meta;
        });
    }

    /** 彻底删除单个项目（含其目录与项目层记忆 memory/ 子目录）。幂等：不存在也不报错。 */
    async hardDelete(id: string): Promise<void> {
        if (!isValidProjectId(id)) return;
        await this.enqueue(async () => {
            const index = await this.loadIndex();
            // 项目层记忆存在 <projectDir>/memory 内，随整目录一并删除，无需单独清理
            await fs.rm(this.projectDir(id), { recursive: true, force: true });
            await this.persistIndex(index.filter((m) => m.id !== id));
        });
    }
}

let store: ProjectStore | null = null;

/** 获取项目仓储单例 */
export function createProjectStore(dir: string = resolveProjectsDir()): ProjectStore {
    return new ProjectStore(dir);
}

export function getProjectStore(): ProjectStore {
    if (!store) store = createProjectStore();
    return store;
}

/**
 * 把项目指令拼成注入系统提示词的段落（超预算截断）。空指令返回空串。
 * 由 runner.ts 的 withProject 使用。
 */
export function buildInjectedProject(project: SavedProject | null): string {
    const content = project?.instructions?.trim();
    if (!content) return '';
    const body =
        content.length > PROJECT_INSTRUCTIONS_BUDGET ? `${content.slice(0, PROJECT_INSTRUCTIONS_BUDGET)}…` : content;
    return `## 项目背景与要求\n以下是当前项目「${project!.name}」的长期设定，请在本轮对话中遵循：\n\n${body}`;
}
