import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from '@/config/atomic-json';
import { paths } from '@/config/paths';
import { createLogger } from '@/platform/logging/index';

import { isValidConversationId } from './store';

const log = createLogger('Checkpoint');

/** 单文件快照大小上限（字节）。超限只记标记、不存副本，回滚时该文件无法恢复（会在 skipped 中报出）。 */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** 轮内首触某文件前记录其 pre 状态的记录器（已绑定 sessionId + turnId）。 */
export interface CheckpointRecorder {
    record(absPath: string): Promise<void>;
}

/** 回滚结果：已还原 / 已删除（原为新建）/ 跳过（超限未存副本）的绝对路径。 */
export interface RewindResult {
    restored: string[];
    deleted: string[];
    skipped: string[];
}

/** 单轮 manifest 的一条：某文件在本轮被首次改动前的 pre 状态。 */
interface ManifestEntry {
    absPath: string;
    /** 改动前文件是否已存在；false 表示本轮新建，回滚时应删除。 */
    existedBefore: boolean;
    /** 超限未存副本（无法回滚该文件）。 */
    skipped?: boolean;
}

type Manifest = Record<string, ManifestEntry>;

/** 文件名/目录名安全化：turnId 来自消息 id，净化成安全目录名。 */
function safeName(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || '_';
    // 回归：点目录仍是合法字符，但 path.join 会折叠 . / ..，回滚清理会误删父目录。
    return safe === '.' || safe === '..' ? `_${safe}` : safe;
}

/** 绝对路径 → 稳定短 hash，用作快照文件名与 manifest key。 */
function hashPath(absPath: string): string {
    return createHash('sha1').update(path.resolve(absPath)).digest('hex');
}

/**
 * 文件级检查点仓储：以「用户轮」(turnId) 为边界，在 Write/Edit 首次改动某文件前快照其 pre 状态，
 * 支持按 turnId 回滚（还原该轮及其后的全部文件改动）。落盘在 `<sessionsDir>/<sid>/checkpoints/`：
 * `order.json`（turnId 创建顺序）+ `<turnId>/manifest.json` + `<turnId>/<hash>`（原内容副本）。
 * 仅覆盖 Write/Edit；Bash 内部改动不快照（见 tech-design §5.5）。
 */
export class CheckpointStore {
    private readonly sessionsRoot: string;
    /** 按 sessionId 串行化读-改-写，避免并发快照/回滚互相踩踏。 */
    private queues = new Map<string, Promise<unknown>>();

    constructor(sessionsRoot = paths.sessionsDir()) {
        this.sessionsRoot = sessionsRoot;
    }

    private enqueue<T>(sid: string, task: () => Promise<T>): Promise<T> {
        const prev = this.queues.get(sid) ?? Promise.resolve();
        const next = prev.then(task, task);
        this.queues.set(
            sid,
            next.catch(() => undefined)
        );
        return next;
    }

    private rootDir(sid: string): string {
        return path.join(this.sessionsRoot, sid, 'checkpoints');
    }
    private orderPath(sid: string): string {
        return path.join(this.rootDir(sid), 'order.json');
    }
    private turnDir(sid: string, turnId: string): string {
        return path.join(this.rootDir(sid), safeName(turnId));
    }

    /** 原子写委托给 platform/fs（唯一实现，含失败清理）。 */
    private writeAtomic(file: string, data: string | Buffer): Promise<void> {
        return writeFileAtomic(file, data);
    }

    private async readJson<T>(file: string, fallback: T): Promise<T> {
        try {
            return JSON.parse(await fs.readFile(file, 'utf8')) as T;
        } catch {
            return fallback;
        }
    }

    private async readOrder(sid: string): Promise<string[]> {
        const value = await this.readJson<unknown>(this.orderPath(sid), []);
        // 回归：JSON 可解析并不代表是数组；坏 order 退为空，避免阻断后续快照和回滚队列。
        return Array.isArray(value) ? value.filter((turn): turn is string => typeof turn === 'string' && !!turn) : [];
    }

    private async readManifest(sid: string, turnId: string): Promise<Manifest> {
        const value = await this.readJson<unknown>(path.join(this.turnDir(sid, turnId), 'manifest.json'), {});
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        // 坏条目不能进入文件操作：仅接受原绝对路径、布尔状态与匹配的 hash，跳过其余而非拖垮整轮。
        return Object.fromEntries(
            Object.entries(value).filter(([hash, entry]) => {
                if (!entry || typeof entry !== 'object') return false;
                const item = entry as Partial<ManifestEntry>;
                return (
                    typeof item.absPath === 'string' &&
                    path.isAbsolute(item.absPath) &&
                    hash === hashPath(item.absPath) &&
                    typeof item.existedBefore === 'boolean' &&
                    (item.skipped === undefined || typeof item.skipped === 'boolean')
                );
            })
        ) as Manifest;
    }

    /** 构造绑定 (sid, turnId) 的记录器；sid 非法或无 turnId 时返回无操作记录器。 */
    recorder(sid: string | undefined, turnId: string | undefined): CheckpointRecorder {
        if (!sid || !isValidConversationId(sid) || !turnId) {
            return { record: async () => undefined };
        }
        return {
            record: (absPath: string) => this.record(sid, turnId, absPath)
        };
    }

    /** 轮内首次改动某文件前快照其 pre 状态（同轮同文件只记一次）。best-effort，失败仅告警不阻断编辑。 */
    private async record(sid: string, turnId: string, absPath: string): Promise<void> {
        const target = path.resolve(absPath);
        try {
            await this.enqueue(sid, async () => {
                // 维护 turnId 创建顺序
                const order = await this.readOrder(sid);
                if (!order.includes(turnId)) {
                    order.push(turnId);
                    await this.writeAtomic(this.orderPath(sid), JSON.stringify(order));
                }
                const manifestPath = path.join(this.turnDir(sid, turnId), 'manifest.json');
                const manifest = await this.readManifest(sid, turnId);
                const hash = hashPath(target);
                if (manifest[hash]) return; // 本轮已快照该文件
                let entry: ManifestEntry;
                try {
                    const stat = await fs.stat(target);
                    if (stat.size > MAX_SNAPSHOT_BYTES) {
                        entry = { absPath: target, existedBefore: true, skipped: true };
                    } else {
                        const content = await fs.readFile(target);
                        await this.writeAtomic(path.join(this.turnDir(sid, turnId), hash), content);
                        entry = { absPath: target, existedBefore: true };
                    }
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                        entry = { absPath: target, existedBefore: false }; // 本轮新建
                    } else {
                        throw err;
                    }
                }
                manifest[hash] = entry;
                await this.writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
            });
        } catch (err) {
            log.warn('记录文件检查点失败，本文件回滚将不可用', { sid, turnId, path: target, err });
        }
    }

    /**
     * 回滚到 toTurnId：把该轮及其后各轮首次改动过的文件恢复到 pre 状态（新建的删除）。
     * toTurnId 不在记录中（该轮及其后无文件改动）时返回空结果。
     */
    async rewind(sid: string, toTurnId: string): Promise<RewindResult> {
        if (!isValidConversationId(sid)) return { restored: [], deleted: [], skipped: [] };
        return this.enqueue(sid, async () => {
            const order = await this.readOrder(sid);
            const idx = order.indexOf(toTurnId);
            if (idx < 0) return { restored: [], deleted: [], skipped: [] };
            const turns = order.slice(idx);
            // 按时间升序取每个文件最早一次的 pre 快照 = 回滚到 toTurn 之前的状态
            const firstByPath = new Map<string, { turnId: string; hash: string; entry: ManifestEntry }>();
            for (const turnId of turns) {
                const manifest = await this.readManifest(sid, turnId);
                for (const [hash, entry] of Object.entries(manifest)) {
                    if (!firstByPath.has(entry.absPath)) firstByPath.set(entry.absPath, { turnId, hash, entry });
                }
            }
            const result: RewindResult = { restored: [], deleted: [], skipped: [] };
            for (const [absPath, { turnId, hash, entry }] of firstByPath) {
                if (entry.skipped) {
                    result.skipped.push(absPath);
                    continue;
                }
                try {
                    if (entry.existedBefore) {
                        const snapshot = await fs.readFile(path.join(this.turnDir(sid, turnId), hash));
                        await fs.mkdir(path.dirname(absPath), { recursive: true });
                        await this.writeAtomic(absPath, snapshot);
                        result.restored.push(absPath);
                    } else {
                        await fs.rm(absPath, { force: true });
                        result.deleted.push(absPath);
                    }
                } catch (err) {
                    log.warn('回滚单个文件失败', { sid, path: absPath, err });
                    result.skipped.push(absPath);
                }
            }
            // 丢弃已回滚的 turn 快照 + 截断 order
            await Promise.all(turns.map((t) => fs.rm(this.turnDir(sid, t), { recursive: true, force: true })));
            await this.writeAtomic(this.orderPath(sid), JSON.stringify(order.slice(0, idx)));
            log.info('文件回滚完成', { sid, toTurnId, ...result });
            return result;
        });
    }
}

let singleton: CheckpointStore | null = null;

export function createCheckpointStore(sessionsRoot: string = paths.sessionsDir()): CheckpointStore {
    return new CheckpointStore(sessionsRoot);
}

export function getCheckpointStore(): CheckpointStore {
    if (!singleton) singleton = createCheckpointStore();
    return singleton;
}
