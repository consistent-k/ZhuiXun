import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ApprovalMode } from '@zhuixun/shared';
import dayjs from 'dayjs';

import { validateQuestionMessages } from '@/agent/tools/question-validation';
import { writeFileAtomic as writeFileAtomicImpl } from '@/config/atomic-json';
import { paths } from '@/config/paths';
import type { ProjectRoot } from '@/modules/projects';
import { getTaskStore } from '@/modules/tasks';
import { isValidId } from '@/platform/fs/id';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('Conversations');

/** 序列化版本，便于后续演进会话文件结构 */
const CURRENT_VERSION = 1;

/**
 * 单条消息（与前端 `types/chat.d.ts` 的 `Message` 对齐）。
 * `parts` 为 AI SDK 的 `UIMessagePart`，后端仅透明持久化、不解析其结构
 * （前后端通过 HTTP JSON 契约解耦，无共享类型包）。
 */
export interface StoredMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
    parts?: unknown[];
    /** UIMessage.metadata（如本轮最后一步 usage）；后端仅透明持久化、不解析其结构，供历史会话还原用量展示。 */
    metadata?: unknown;
}

/** 会话来源标记：桌面端会话缺省（undefined）；渠道会话带 channelId + IM 用户 id，供侧栏「渠道」分区分桶。 */
export interface ConversationOrigin {
    kind: 'channel';
    channelId: string;
    channelName?: string;
    imUserId: string;
}

/**
 * 上下文压缩检查点：问答过程中自动压缩上下文（类 Claude Code /compact）的持久化状态。
 * 发生压缩后记录「早期消息摘要 + 保留边界」，后续每轮据此重建喂给模型的输入（摘要 + 边界之后的近期消息），
 * 避免每轮重复摘要。磁盘与界面始终保留全量原始 messages（非破坏式），本检查点仅服务端重建模型输入时使用。
 */
export interface CompactionCheckpoint {
    /** 对边界之前所有消息生成的摘要文本（滚动压缩时会把旧摘要并入新摘要）。 */
    summary: string;
    /** 保留区首条消息的 id（该消息及其之后原样保留，之前的被摘要替代）。 */
    boundaryMessageId: string;
    /** 本检查点生成时间戳。 */
    createdAt: number;
    /** 被折叠进摘要的消息条数（累计），仅供展示/排障。 */
    summarizedCount: number;
    /** 压缩前的估算/已知 token 数，仅供展示/排障。 */
    tokensBefore?: number;
}

/** 会话全量（落盘为单文件 `<id>.json`） */
export interface SavedConversation {
    version: number;
    id: string;
    title: string;
    /** 标题是否由 AI 自动生成；置位后整单 upsert 不再覆盖标题（见 upsert 的标题锁），保证自动标题稳定。 */
    titleAuto?: boolean;
    /** 仅服务端写入，用于审批与客户端交互续跑。 */
    approvalTurn?: ApprovalTurn;
    /** 归属项目 id；缺省（undefined）表示「未分组」。移动会话只改此字段，不搬文件。 */
    projectId?: string;
    /** 会话级表达风格覆盖；缺省表示跟随全局默认。 */
    personaId?: string;
    /** 会话来源；缺省表示桌面端普通会话，渠道会话带 origin。 */
    origin?: ConversationOrigin;
    createdAt: number;
    updatedAt: number;
    messages: StoredMessage[];
    /** 上下文压缩检查点；缺省表示该会话尚未发生自动压缩。 */
    compaction?: CompactionCheckpoint;
    /**
     * 工作目录快照：发起会话时冻结的项目根集合（primary=shell cwd）。一旦写入即不随项目后续改动变化，
     * 保证历史会话仍在各自发起时的目录执行；缺省表示该会话未绑定项目目录（走临时工作区）。
     */
    roots?: ProjectRoot[];
}

/** 会话列表元信息（不含 messages，供侧栏秒开，落在 `index.json`） */
export interface ConversationMeta {
    id: string;
    title: string;
    /** 标题是否由 AI 自动生成（与 `SavedConversation.titleAuto` 同步，随索引落盘）。 */
    titleAuto?: boolean;
    projectId?: string;
    /** 会话级表达风格覆盖；缺省表示跟随全局默认。 */
    personaId?: string;
    origin?: ConversationOrigin;
    createdAt: number;
    updatedAt: number;
}

/** 导出包：全部会话的全量快照，供下载/导入 */
export interface ConversationExport {
    version: number;
    exportedAt: number;
    conversations: SavedConversation[];
}

/** upsert 入参；`updatedAt` 由服务端赋值，`createdAt` 缺省时沿用已存在值或取当前时间 */
export interface ConversationUpsert {
    title: string;
    /** 自动标题标记；缺省时 upsert 沿用已存值，不会把已置位的标记清掉。 */
    titleAuto?: boolean;
    projectId?: string;
    /** 会话级表达风格覆盖；缺省时沿用已存值。 */
    personaId?: string;
    origin?: ConversationOrigin;
    createdAt: number;
    messages: StoredMessage[];
    /** 压缩检查点；缺省时 upsert 沿用会话已存检查点（避免每轮落库把检查点清掉）。 */
    compaction?: CompactionCheckpoint;
    /** 工作目录快照（仅首轮写入；已存快照则冻结不覆盖）。 */
    roots?: ProjectRoot[];
}

/** 追加消息（一轮对话落库）时可选的会话元信息。 */
export interface ApprovalTurn {
    turnId: string;
    mode: ApprovalMode;
    pending?: Pick<StoredMessage, 'id' | 'parts'>;
}

export interface TurnMeta {
    approvalTurn?: ApprovalTurn;
    /** 非 AI 命名（titleAuto 未置位）时可用于更新标题。 */
    title?: string;
    projectId?: string;
    /** 会话级表达风格覆盖；缺省时沿用已存值。 */
    personaId?: string;
    /** 工作目录快照；仅首轮（尚无快照）写入。 */
    roots?: ProjectRoot[];
}

/**
 * 会话模块对外契约（模块外只经此接口使用）。
 * 实现是 ConversationStore；接口刻意不含私有队列/缓存细节。
 */
export interface IConversationService {
    readHistory(): Promise<ConversationHistoryEvent[]>;
    list(projectId?: string | null): Promise<ConversationMeta[]>;
    get(id: string): Promise<SavedConversation | null>;
    upsert(id: string, input: ConversationUpsert): Promise<ConversationMeta>;
    appendMessages(id: string, incoming: StoredMessage[], meta?: TurnMeta): Promise<ConversationMeta>;
    updateProjectId(id: string, projectId: string | null): Promise<ConversationMeta | null>;
    updatePersonaId(id: string, personaId: string | null): Promise<ConversationMeta | null>;
    updateTitle(id: string, title: string, opts?: { auto?: boolean }): Promise<ConversationMeta | null>;
    truncateFrom(id: string, messageId: string): Promise<ConversationMeta | null>;
    updateCompaction(id: string, checkpoint: CompactionCheckpoint): Promise<void>;
    handleProjectRemoval(projectId: string, cascade: boolean): Promise<string[]>;
    delete(id: string): Promise<void>;
    clear(): Promise<number>;
    exportOne(id: string): Promise<SavedConversation | null>;
    exportAll(): Promise<ConversationExport>;
    importMany(conversations: unknown): Promise<{ imported: number; remapped: Record<string, string> }>;
}

/** history.jsonl 的一行：会话变更事件的 append-only 审计日志 */
export interface ConversationHistoryEvent {
    /** 事件时间（ISO 8601） */
    time: string;
    /** 事件类型 */
    event: 'save' | 'delete' | 'clear';
    id?: string;
    title?: string;
    createdAt?: number;
    updatedAt?: number;
    /** 保存时的消息条数 */
    messageCount?: number;
}

/**
 * 仅允许安全字符的 id：id 会拼进文件名，必须杜绝路径穿越（如 `../`）。
 * 前端用 `crypto.randomUUID()` 生成，形如 uuid；这里放宽到字母数字下划线连字符。
 */
export function isValidConversationId(id: string): boolean {
    return isValidId(id);
}

/**
 * 会话根目录：与技能/记忆同源，落在用户可写目录 `~/.zhuixun/sessions/`，不写进代码库。
 * 可用 env `SESSIONS_USER_DIR` 覆盖（与 `SKILLS_USER_DIR` / `MEMORY_USER_DIR` 对齐）。
 * 基于 os.homedir()，dev（tsx 跑 src）与打包（app.js 在只读 resources）两形态指向同一用户目录。
 */
function resolveSessionsDir(): string {
    return paths.sessionsDir();
}

function toMeta(conv: SavedConversation): ConversationMeta {
    return {
        id: conv.id,
        title: conv.title,
        titleAuto: conv.titleAuto,
        projectId: conv.projectId,
        personaId: conv.personaId,
        origin: conv.origin,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt
    };
}

/** 列表按最近更新倒序，与侧栏展示一致 */
function sortMetas(metas: ConversationMeta[]): ConversationMeta[] {
    return [...metas].sort((a, b) => b.updatedAt - a.updatedAt);
}

function isConversationMeta(value: unknown): value is ConversationMeta {
    if (!value || typeof value !== 'object') return false;
    const meta = value as Partial<ConversationMeta>;
    return (
        typeof meta.id === 'string' &&
        isValidConversationId(meta.id) &&
        typeof meta.title === 'string' &&
        typeof meta.createdAt === 'number' &&
        Number.isFinite(meta.createdAt) &&
        typeof meta.updatedAt === 'number' &&
        Number.isFinite(meta.updatedAt)
    );
}

/**
 * 消息时间戳以**首次落库**为准：同 id 的消息沿用已存时间戳，新消息才取调用方值（缺省为本次保存时刻）。
 *
 * 前端写穿与后端 persistTurn 每次都整单 upsert、且都给每条消息填 `Date.now()`，若不在这里收口，
 * 每保存一次所有历史消息的时间都被改写为同一时刻（实测会话里 user/assistant 时间戳完全相同）。
 * 后端在请求开始时先落 user 消息、流结束再落 assistant，因此两者各自得到真实的发生时刻。
 */
function preserveMessageTimestamps(
    incoming: StoredMessage[],
    previous: StoredMessage[] | undefined,
    now: number
): StoredMessage[] {
    const known = new Map<string, number>();
    for (const m of previous ?? []) {
        if (typeof m.timestamp === 'number') known.set(m.id, m.timestamp);
    }
    return incoming.map((m) => ({ ...m, timestamp: known.get(m.id) ?? m.timestamp ?? now }));
}

/**
 * 合并消息：已存顺序为底，新 id 追加，同 id 以新内容覆盖但保留首次落库时间戳。
 * 用于 `appendMessages` —— 请求起始与 onFinish 各自带来同一批历史消息，按 id 去重才不会重复落盘。
 */
function mergeMessages(existing: StoredMessage[], incoming: StoredMessage[], now: number): StoredMessage[] {
    const positions = new Map(existing.map((m, i) => [m.id, i]));
    const merged = existing.map((m) => ({ ...m }));
    for (const msg of incoming) {
        const at = positions.get(msg.id);
        if (at === undefined) {
            positions.set(msg.id, merged.length);
            merged.push({ ...msg, timestamp: msg.timestamp ?? now });
        } else {
            merged[at] = { ...msg, timestamp: merged[at].timestamp ?? msg.timestamp ?? now };
        }
    }
    return merged;
}

/** 由首条用户消息派生标题（与前端 send() 的截断规则一致）。 */
export function deriveTitleFromMessages(messages: StoredMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user');
    const text = firstUser?.content?.trim() || '新会话';
    return text.slice(0, 20) + (text.length > 20 ? '...' : '');
}

/**
 * 会话仓储：每会话一个 JSON 文件 + 一份 `index.json` 元信息索引。
 * 写操作走串行队列 + 原子写（临时文件 rename），避免并发落库损坏文件或索引，
 * 范式与 `features/memory/store.ts` 一致。
 */
export class ConversationStore {
    private readonly dir: string;
    private readonly indexPath: string;
    private readonly historyPath: string;
    private indexCache: ConversationMeta[] | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(dir = resolveSessionsDir()) {
        this.dir = dir;
        this.indexPath = path.join(dir, 'index.json');
        this.historyPath = path.join(dir, 'history.jsonl');
    }

    private conversationPath(id: string): string {
        return path.join(this.dir, `${id}.json`);
    }

    /** 会话附件目录 <dir>/<id>/（对话上传的图片/PDF 落此，随会话删除清理）。 */
    private uploadsPath(id: string): string {
        return path.join(this.dir, id);
    }

    private async loadIndex(): Promise<ConversationMeta[]> {
        if (this.indexCache) return this.indexCache;
        try {
            const raw = await fs.readFile(this.indexPath, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            // 回归：合法 JSON 也可能是 null/对象或含坏条目；不能发布到缓存，否则 list 崩溃且删除路径不可信。
            if (!Array.isArray(parsed) || !parsed.every(isConversationMeta)) throw new Error('会话索引形状无效');
            this.indexCache = parsed;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.error('索引读取/解析失败，扫描会话文件重建', { err });
            }
            // 首次运行、索引缺失或损坏：扫描 `<id>.json` 重建（不落盘，等下次写操作再持久化，避免读路径与写队列竞争）
            this.indexCache = await this.rebuildIndex();
        }
        return this.indexCache;
    }

    /** 扫描目录重建索引；跳过 `index.json` 与解析失败的单个文件 */
    private async rebuildIndex(): Promise<ConversationMeta[]> {
        let files: string[];
        try {
            files = await fs.readdir(this.dir);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw err;
        }
        const metas: ConversationMeta[] = [];
        for (const file of files) {
            if (!file.endsWith('.json') || file === 'index.json') continue;
            try {
                const raw = await fs.readFile(path.join(this.dir, file), 'utf8');
                const conv: unknown = JSON.parse(raw);
                // 重建同样校验元信息，避免 {} 等坏文件再次污染索引；文件名必须与 id 一致。
                if (!isConversationMeta(conv) || file !== `${conv.id}.json`) continue;
                metas.push(toMeta(conv as SavedConversation));
            } catch (err) {
                log.error('跳过损坏的会话文件', { file, err });
            }
        }
        return sortMetas(metas);
    }

    /** 串行化写操作，保证会话文件与索引不交叉写入 */
    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** 原子写委托给 platform/fs（唯一实现）；并发串行化仍由本 store 的 enqueue 负责。 */
    private writeFileAtomic(filePath: string, content: string): Promise<void> {
        return writeFileAtomicImpl(filePath, content);
    }

    private async persistIndex(metas: ConversationMeta[]): Promise<void> {
        const next = sortMetas(metas);
        await this.writeFileAtomic(this.indexPath, JSON.stringify(next, null, 2));
        this.indexCache = next;
    }

    /** 追加一条变更事件到 history.jsonl（append-only 审计日志）；best-effort，失败不影响主写入 */
    private async appendHistory(event: ConversationHistoryEvent): Promise<void> {
        try {
            await fs.mkdir(this.dir, { recursive: true });
            await fs.appendFile(this.historyPath, `${JSON.stringify(event)}\n`, 'utf8');
        } catch (err) {
            log.error('追加历史日志失败（忽略）', { err });
        }
    }

    /** 读取 history.jsonl 全部事件（按写入顺序）；容错跳过损坏行，文件不存在返回空 */
    async readHistory(): Promise<ConversationHistoryEvent[]> {
        let raw: string;
        try {
            raw = await fs.readFile(this.historyPath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw err;
        }
        const events: ConversationHistoryEvent[] = [];
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const value: unknown = JSON.parse(trimmed);
                // 回归：null/数字/未知事件虽可解析，却不是历史事件；与语法损坏行一样跳过。
                if (!value || typeof value !== 'object') continue;
                const event = value as Partial<ConversationHistoryEvent>;
                if (typeof event.time !== 'string' || !['save', 'delete', 'clear'].includes(event.event ?? ''))
                    continue;
                events.push(event as ConversationHistoryEvent);
            } catch {
                // 跳过损坏行
            }
        }
        return events;
    }

    /** 会话列表（仅元信息，最近更新倒序）。传 projectId 时只返回该项目的会话（null 表示未分组）。 */
    async list(projectId?: string | null): Promise<ConversationMeta[]> {
        const all = sortMetas(await this.loadIndex());
        if (projectId === undefined) return all;
        // 显式过滤：null / '' 表示未分组桶
        const target = projectId || undefined;
        return all.filter((m) => (m.projectId || undefined) === target);
    }

    /** 读取单个会话全量；不存在或 id 非法返回 null */
    async get(id: string): Promise<SavedConversation | null> {
        if (!isValidConversationId(id)) return null;
        try {
            const raw = await fs.readFile(this.conversationPath(id), 'utf8');
            return JSON.parse(raw) as SavedConversation;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
        }
    }

    /** 幂等 upsert 整个会话（建/存均走这里），返回最新元信息 */
    async upsert(id: string, input: ConversationUpsert): Promise<ConversationMeta> {
        if (!isValidConversationId(id)) throw new Error('非法会话 id');
        return this.enqueue(async () => {
            validateQuestionMessages(input.messages);
            const index = await this.loadIndex();
            const existing = index.find((m) => m.id === id);
            // 读已存全量会话：仅为沿用压缩检查点（compaction 不在索引元信息里），避免整单 upsert 把检查点清掉。
            const existingConv = await this.get(id);
            // 标题锁：会话一旦被 AI 自动命名（titleAuto），后续整单 upsert（含前端乐观写穿）不再覆盖标题，
            // 保证自动标题稳定；仅服务端 updateTitle 可改。titleAuto 标记缺省沿用已存值，避免被清掉。
            const titleLocked = existing?.titleAuto === true;
            const now = Date.now();
            const conv: SavedConversation = {
                version: CURRENT_VERSION,
                id,
                title: titleLocked && existing ? existing.title : input.title,
                titleAuto: input.titleAuto ?? existing?.titleAuto,
                projectId: input.projectId,
                personaId: input.personaId ?? existingConv?.personaId,
                origin: input.origin ?? existing?.origin,
                createdAt: input.createdAt || existing?.createdAt || now,
                updatedAt: now,
                messages: preserveMessageTimestamps(input.messages, existingConv?.messages, now),
                compaction: input.compaction ?? existingConv?.compaction,
                approvalTurn: existingConv?.approvalTurn,
                // 工作目录快照冻结：已存快照优先，仅首轮（无快照）才写入本次传入值
                roots: existingConv?.roots ?? input.roots
            };
            await this.writeFileAtomic(this.conversationPath(id), JSON.stringify(conv, null, 2));
            const meta = toMeta(conv);
            await this.persistIndex([...index.filter((m) => m.id !== id), meta]);
            await this.appendHistory({
                time: dayjs().toISOString(),
                event: 'save',
                id,
                title: conv.title,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                messageCount: conv.messages.length
            });
            return meta;
        });
    }

    /**
     * 追加/更新消息（一轮对话的落库入口）。
     *
     * 与 `upsert` 的区别：读-合并-写**全部在同一条串行队列内**完成。请求起始（user）
     * 与 onFinish（assistant）是两次并发调用，入队顺序即调用顺序，后写不会把先写覆盖掉。
     * 同 id 消息以新内容为准，但时间戳沿用首次落库值。
     *
     * `upsert` 仍保留给导入与前端整单写穿；两者共用标题锁与目录快照冻结语义。
     */
    async appendMessages(id: string, incoming: StoredMessage[], meta: TurnMeta = {}): Promise<ConversationMeta> {
        if (!isValidConversationId(id)) throw new Error('非法会话 id');
        return this.enqueue(async () => {
            const index = await this.loadIndex();
            const existing = await this.get(id);
            const now = Date.now();
            const base: SavedConversation = existing ?? {
                version: CURRENT_VERSION,
                id,
                title: meta.title ?? deriveTitleFromMessages(incoming),
                projectId: meta.projectId,
                personaId: meta.personaId,
                createdAt: now,
                updatedAt: now,
                messages: [],
                roots: meta.roots
            };

            const conv: SavedConversation = {
                ...base,
                // 标题锁：AI 已命名（titleAuto）则任何追加都不覆盖；否则允许用 meta.title 更新。
                title: base.titleAuto ? base.title : (meta.title ?? base.title),
                projectId: base.projectId ?? meta.projectId,
                personaId: base.personaId ?? meta.personaId,
                // 目录快照只写一次（首轮），后续不覆盖。
                roots: base.roots ?? meta.roots,
                approvalTurn: meta.approvalTurn ?? base.approvalTurn,
                updatedAt: now,
                messages: mergeMessages(base.messages, incoming, now)
            };

            validateQuestionMessages(conv.messages);
            await this.writeFileAtomic(this.conversationPath(id), JSON.stringify(conv, null, 2));
            const out = toMeta(conv);
            await this.persistIndex([...index.filter((m) => m.id !== id), out]);
            await this.appendHistory({
                time: dayjs().toISOString(),
                event: 'save',
                id,
                title: conv.title,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                messageCount: conv.messages.length
            });
            return out;
        });
    }

    /**
     * 移动会话到项目（轻量：只改 projectId + 单文件 + 索引，不动 messages）。
     * projectId 传 null/undefined 表示移出到「未分组」。会话不存在返回 null。
     */
    async updateProjectId(id: string, projectId: string | null): Promise<ConversationMeta | null> {
        if (!isValidConversationId(id)) return null;
        return this.enqueue(async () => {
            const conv = await this.get(id);
            if (!conv) return null;
            conv.projectId = projectId || undefined;
            conv.updatedAt = Date.now();
            await this.writeFileAtomic(this.conversationPath(id), JSON.stringify(conv, null, 2));
            const meta = toMeta(conv);
            const index = await this.loadIndex();
            await this.persistIndex([...index.filter((m) => m.id !== id), meta]);
            return meta;
        });
    }

    /**
     * 设置/清除会话级风格覆盖（轻量：只改 personaId + 单文件 + 索引，不动 messages）。
     * null 表示回到「跟随全局默认」。会话不存在返回 null。
     */
    async updatePersonaId(id: string, personaId: string | null): Promise<ConversationMeta | null> {
        if (!isValidConversationId(id)) return null;
        return this.enqueue(async () => {
            const conv = await this.get(id);
            if (!conv) return null;
            conv.personaId = personaId || undefined;
            conv.updatedAt = Date.now();
            await this.writeFileAtomic(this.conversationPath(id), JSON.stringify(conv, null, 2));
            const meta = toMeta(conv);
            const index = await this.loadIndex();
            await this.persistIndex([...index.filter((m) => m.id !== id), meta]);
            return meta;
        });
    }

    /**
     * 设置会话标题（轻量：只改 title + 单文件 + 索引，不动 messages）。
     * `auto` 置位表示 AI 自动生成，此后整单 upsert 不再覆盖标题（见 upsert 的标题锁）。
     * 会话不存在或标题为空返回 null。
     */
    async updateTitle(id: string, title: string, opts?: { auto?: boolean }): Promise<ConversationMeta | null> {
        if (!isValidConversationId(id)) return null;
        const next = title.trim();
        if (!next) return null;
        return this.enqueue(async () => {
            const conv = await this.get(id);
            if (!conv) return null;
            conv.title = next;
            if (opts?.auto) conv.titleAuto = true;
            conv.updatedAt = Date.now();
            await this.writeFileAtomic(this.conversationPath(id), JSON.stringify(conv, null, 2));
            const meta = toMeta(conv);
            const index = await this.loadIndex();
            await this.persistIndex([...index.filter((m) => m.id !== id), meta]);
            return meta;
        });
    }

    /**
     * 回滚：删除指定消息（含该条）及其后的全部消息，返回截断后的元信息（轻量，只改单文件 + 索引）。
     * 会话不存在或 messageId 不在会话中返回 null。供 rewind 路由在文件还原后截断对话历史。
     */
    async truncateFrom(id: string, messageId: string): Promise<ConversationMeta | null> {
        if (!isValidConversationId(id)) return null;
        return this.enqueue(async () => {
            const conv = await this.get(id);
            if (!conv) return null;
            const idx = conv.messages.findIndex((m) => m.id === messageId);
            if (idx < 0) return null;
            conv.messages = conv.messages.slice(0, idx);
            conv.updatedAt = Date.now();
            await this.writeFileAtomic(this.conversationPath(id), JSON.stringify(conv, null, 2));
            const meta = toMeta(conv);
            const index = await this.loadIndex();
            await this.persistIndex([...index.filter((m) => m.id !== id), meta]);
            await this.appendHistory({
                time: dayjs().toISOString(),
                event: 'save',
                id,
                title: conv.title,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                messageCount: conv.messages.length
            });
            return meta;
        });
    }

    /**
     * 写入/更新会话的上下文压缩检查点（轻量：只改单文件的 compaction 字段，不动 messages、不改索引、不改 updatedAt——
     * 压缩是内部重建状态，不应把会话顶到侧栏最前）。会话不存在（如全新会话首轮尚未落库）时静默跳过。
     */
    async updateCompaction(id: string, checkpoint: CompactionCheckpoint): Promise<void> {
        if (!isValidConversationId(id)) return;
        await this.enqueue(async () => {
            const conv = await this.get(id);
            if (!conv) return;
            conv.compaction = checkpoint;
            await this.writeFileAtomic(this.conversationPath(id), JSON.stringify(conv, null, 2));
        });
    }

    /**
     * 项目删除时的批量处置：把该项目下所有会话复位为「未分组」（reassign）或整批删除（cascade）。
     * 返回受影响的会话 id 列表。
     */
    async handleProjectRemoval(projectId: string, cascade: boolean): Promise<string[]> {
        if (!projectId) return [];
        return this.enqueue(async () => {
            const index = await this.loadIndex();
            const affected = index.filter((m) => m.projectId === projectId).map((m) => m.id);
            if (affected.length === 0) return [];
            if (cascade) {
                await Promise.all(
                    affected.flatMap((id) => [
                        fs.rm(this.conversationPath(id), { force: true }),
                        fs.rm(this.uploadsPath(id), { recursive: true, force: true }),
                        getTaskStore().delete(id)
                    ])
                );
                await this.persistIndex(index.filter((m) => m.projectId !== projectId));
            } else {
                for (const id of affected) {
                    const conv = await this.get(id);
                    if (!conv) continue;
                    conv.projectId = undefined;
                    await this.writeFileAtomic(this.conversationPath(id), JSON.stringify(conv, null, 2));
                }
                const next = index.map((m) => (m.projectId === projectId ? { ...m, projectId: undefined } : m));
                await this.persistIndex(next);
            }
            return affected;
        });
    }

    /** 删除单个会话（幂等：不存在也不报错） */
    async delete(id: string): Promise<void> {
        if (!isValidConversationId(id)) return;
        await this.enqueue(async () => {
            const index = await this.loadIndex();
            await fs.rm(this.conversationPath(id), { force: true });
            await fs.rm(this.uploadsPath(id), { recursive: true, force: true });
            await getTaskStore().delete(id);
            await this.persistIndex(index.filter((m) => m.id !== id));
            await this.appendHistory({ time: dayjs().toISOString(), event: 'delete', id });
        });
    }

    /** 清空全部会话，返回清除数量 */
    async clear(): Promise<number> {
        return this.enqueue(async () => {
            const index = await this.loadIndex();
            const count = index.length;
            await Promise.all(
                index.flatMap((m) => [
                    fs.rm(this.conversationPath(m.id), { force: true }),
                    fs.rm(this.uploadsPath(m.id), { recursive: true, force: true }),
                    getTaskStore().delete(m.id)
                ])
            );
            await this.persistIndex([]);
            await this.appendHistory({ time: dayjs().toISOString(), event: 'clear' });
            return count;
        });
    }

    /** 导出单个会话全量（不含附件二进制，仅会话 JSON）。不存在返回 null。 */
    async exportOne(id: string): Promise<SavedConversation | null> {
        return this.get(id);
    }

    /** 导出全部会话为一个数组（按最近更新倒序）。供「导出全部」下载。 */
    async exportAll(): Promise<ConversationExport> {
        const metas = sortMetas(await this.loadIndex());
        const conversations: SavedConversation[] = [];
        for (const m of metas) {
            const conv = await this.get(m.id);
            if (conv) conversations.push(conv);
        }
        return { version: CURRENT_VERSION, exportedAt: Date.now(), conversations };
    }

    /**
     * 导入会话：对每条做形状校验，id 与现有冲突（或非法）则重新生成 uuid，逐条 upsert。
     * 返回导入成功数与 id 重映射（旧 id → 新 id，仅冲突时出现）。
     */
    async importMany(conversations: unknown): Promise<{ imported: number; remapped: Record<string, string> }> {
        const list = Array.isArray(conversations) ? conversations : [];
        // 先检查整批新版问题，再走既有 upsert；避免坏配对导致部分导入，不增加专用保存通道。
        const validated = list.map(normalizeImported).filter((conv) => conv !== null);
        for (const conv of validated) validateQuestionMessages(conv.messages);
        const remapped: Record<string, string> = {};
        let imported = 0;
        for (const conv of validated) {
            let targetId = conv.id;
            const exists = (await this.get(targetId)) !== null;
            if (!isValidConversationId(targetId) || exists) {
                const newId = crypto.randomUUID();
                remapped[conv.id] = newId;
                targetId = newId;
            }
            await this.upsert(targetId, {
                title: conv.title,
                titleAuto: conv.titleAuto,
                projectId: conv.projectId,
                personaId: conv.personaId,
                origin: conv.origin,
                createdAt: conv.createdAt || Date.now(),
                messages: conv.messages,
                compaction: conv.compaction,
                roots: conv.roots
            });
            imported++;
        }
        return { imported, remapped };
    }
}

function normalizeCompaction(raw: unknown): CompactionCheckpoint | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = raw as Partial<CompactionCheckpoint>;
    if (
        typeof value.summary !== 'string' ||
        typeof value.boundaryMessageId !== 'string' ||
        typeof value.createdAt !== 'number' ||
        !Number.isFinite(value.createdAt) ||
        typeof value.summarizedCount !== 'number' ||
        !Number.isFinite(value.summarizedCount)
    ) {
        return undefined;
    }
    return {
        summary: value.summary,
        boundaryMessageId: value.boundaryMessageId,
        createdAt: value.createdAt,
        summarizedCount: value.summarizedCount,
        tokensBefore:
            typeof value.tokensBefore === 'number' && Number.isFinite(value.tokensBefore)
                ? value.tokensBefore
                : undefined
    };
}

/** 校验并规整一条导入的会话；形状不合法返回 null（整条跳过，不中断整体导入）。 */
function normalizeImported(raw: unknown): SavedConversation | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Partial<SavedConversation>;
    if (typeof o.id !== 'string' || typeof o.title !== 'string') return null;
    if (!Array.isArray(o.messages)) return null;
    return {
        version: CURRENT_VERSION,
        id: o.id,
        title: o.title,
        titleAuto: typeof o.titleAuto === 'boolean' ? o.titleAuto : undefined,
        projectId: typeof o.projectId === 'string' ? o.projectId : undefined,
        personaId: typeof o.personaId === 'string' && o.personaId ? o.personaId : undefined,
        origin: o.origin,
        createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
        updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
        messages: o.messages as StoredMessage[],
        compaction: normalizeCompaction(o.compaction),
        roots: Array.isArray(o.roots) ? (o.roots as ProjectRoot[]) : undefined
    };
}

let store: ConversationStore | null = null;

/** 获取会话服务单例（对外类型是契约接口，隐藏仓储实现）。 */
export function createConversationStore(dir: string = resolveSessionsDir()): IConversationService {
    return new ConversationStore(dir);
}

export function getConversationStore(): IConversationService {
    if (!store) store = new ConversationStore();
    return store;
}
