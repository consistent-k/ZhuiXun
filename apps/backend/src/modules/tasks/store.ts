import fs from 'node:fs/promises';
import path from 'node:path';

import type { Task, TaskStatus } from '@zhuixun/shared';

import { writeJsonAtomic } from '@/config/atomic-json';
import { paths } from '@/config/paths';
import { isValidId } from '@/platform/fs/id';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('Tasks');

/** 序列化版本，便于后续演进任务文件结构 */
const CURRENT_VERSION = 1;

export type { Task, TaskStatus };

/** 落盘结构：一会话一文件 */
interface TaskFileData {
    version: number;
    /** id 自增游标 */
    seq: number;
    tasks: Task[];
}

export interface TaskCreateInput {
    subject: string;
    description?: string;
    activeForm?: string;
}

export interface TaskUpdateInput {
    taskId: string;
    status?: TaskStatus;
    subject?: string;
    description?: string;
    activeForm?: string;
    /** 新增：本任务阻塞的下游任务 id */
    addBlocks?: string[];
    /** 新增：阻塞本任务的上游任务 id */
    addBlockedBy?: string[];
}

/** 单笔补丁的应用结果（批量内逐条收集，不单独回显全量） */
type PatchResult = { ok: true } | { ok: false; message: string };

/**
 * 批量更新结果：只要整批中至少一笔生效即 ok:true 并回显全量，failed 逐条收集未生效项供模型自纠；
 * 整批无一生效时回 ok:false（避免回显"成功"误导模型）。前端只读 tasks，failed 为增量字段。
 */
export type TaskBatchResult =
    { ok: true; tasks: Task[]; failed: { taskId: string; message: string }[] } | { ok: false; message: string };

/** 状态图标，用于 push 注入系统提示词时的紧凑展示 */
const STATUS_ICON: Record<TaskStatus, string> = {
    pending: '⬜',
    in_progress: '🔄',
    completed: '✅'
};

/**
 * id 会拼进文件名，必须杜绝路径穿越；与会话 id 校验一致（字母数字下划线连字符）。
 * 会话恒有 id（前端 crypto.randomUUID）；缺失或非法 sessionId 直接拒绝，避免误写固定任务文件。
 */
function isValidSessionId(id: string): boolean {
    return isValidId(id);
}

/** 拼进系统提示词：空清单不注入。列出 id/状态/依赖，让模型按 id 精确更新并据依赖决定下一步。 */
export function buildInjectedTasks(tasks: Task[]): string {
    if (tasks.length === 0) return '';
    const lines = tasks.map((t) => {
        const dep = t.blockedBy.length > 0 ? ` 依赖[${t.blockedBy.join(',')}]` : '';
        const active = t.status === 'in_progress' && t.activeForm ? `（${t.activeForm}）` : '';
        return `- [${t.id}] ${STATUS_ICON[t.status]} ${t.subject}${active}${dep}`;
    });
    return [
        '## 当前任务清单',
        '这是本会话的任务清单（真源在服务端）。请按 id 用 TaskUpdate 更新状态；',
        '同一时刻最多一个任务 in_progress；被未完成任务阻塞的任务不可置 in_progress。',
        '',
        ...lines
    ].join('\n');
}

// PLACEHOLDER_STORE

/** 是否存在环：在 blockedBy 有向图上做 DFS（灰/黑着色）。 */
function hasCycle(tasks: Task[]): boolean {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const state = new Map<string, 1 | 2>(); // 1=访问中(灰) 2=完成(黑)
    const visit = (id: string): boolean => {
        const s = state.get(id);
        if (s === 1) return true; // 回边 → 有环
        if (s === 2) return false;
        state.set(id, 1);
        for (const next of byId.get(id)?.blockedBy ?? []) {
            if (byId.has(next) && visit(next)) return true;
        }
        state.set(id, 2);
        return false;
    };
    for (const t of tasks) {
        if (visit(t.id)) return true;
    }
    return false;
}

/** 就绪校验：blockedBy 中的任务需全部 completed，才允许本任务 in_progress。 */
function isReady(task: Task, tasks: Task[]): boolean {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return task.blockedBy.every((id) => byId.get(id)?.status === 'completed');
}

/** 去重并入数组（保持原序） */
function mergeUnique(base: string[], add: string[]): string[] {
    const set = new Set(base);
    for (const id of add) set.add(id);
    return [...set];
}

/** 各状态计数，用于监控日志 */
function countByStatus(tasks: Task[]): Record<TaskStatus, number> {
    return {
        pending: tasks.filter((t) => t.status === 'pending').length,
        in_progress: tasks.filter((t) => t.status === 'in_progress').length,
        completed: tasks.filter((t) => t.status === 'completed').length
    };
}

/**
 * 任务仓储：一会话一 JSON 文件（`~/.zhuixun/tasks/<sid>.json`）。
 * 写操作走串行队列 + 原子写（临时文件 rename），范式与 memory/conversations store 一致。
 */
export class TaskStore {
    private readonly dir: string;
    private cache = new Map<string, TaskFileData>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(dir = paths.tasksDir()) {
        this.dir = dir;
    }

    private key(sessionId?: string): string {
        const id = sessionId?.trim();
        if (!id || !isValidSessionId(id)) throw new Error('缺少或非法会话 id');
        return id;
    }

    private filePath(key: string): string {
        return path.join(this.dir, `${key}.json`);
    }

    private empty(): TaskFileData {
        return { version: CURRENT_VERSION, seq: 0, tasks: [] };
    }

    private async load(key: string): Promise<TaskFileData> {
        const cached = this.cache.get(key);
        if (cached) return cached;
        let data = this.empty();
        try {
            const raw = await fs.readFile(this.filePath(key), 'utf8');
            const parsed = JSON.parse(raw) as TaskFileData;
            data = { version: CURRENT_VERSION, seq: parsed.seq ?? 0, tasks: parsed.tasks ?? [] };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.error('读取任务文件失败，按空清单处理', { key, err });
            }
        }
        this.cache.set(key, data);
        return data;
    }

    private enqueue<T>(key: string, fn: (data: TaskFileData) => T): Promise<T> {
        const run = this.queue.then(async () => {
            const current = await this.load(key);
            // 深拷贝为草稿，持久化成功后才提交缓存，避免写盘失败留下脏缓存
            const draft: TaskFileData = {
                version: current.version,
                seq: current.seq,
                tasks: current.tasks.map((t) => ({ ...t, blocks: [...t.blocks], blockedBy: [...t.blockedBy] }))
            };
            const result = fn(draft);
            await this.persist(key, draft);
            return result;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async persist(key: string, data: TaskFileData): Promise<void> {
        // 原子写与失败清理委托给 platform/fs；写入成功后才提交内存缓存。
        await writeJsonAtomic(this.filePath(key), data);
        this.cache.set(key, data);
    }

    /** 读取会话任务快照 */
    async list(sessionId?: string): Promise<Task[]> {
        const data = await this.load(this.key(sessionId));
        return data.tasks.map((t) => ({ ...t }));
    }

    /** 批量创建任务，服务端分配自增 id，返回全量 */
    async create(sessionId: string | undefined, items: TaskCreateInput[]): Promise<Task[]> {
        const key = this.key(sessionId);
        return this.enqueue(key, (data) => {
            for (const item of items) {
                data.seq += 1;
                data.tasks.push({
                    id: String(data.seq),
                    subject: item.subject,
                    description: item.description,
                    activeForm: item.activeForm,
                    status: 'pending',
                    blocks: [],
                    blockedBy: []
                });
            }
            log.info('TaskCreate', { key, added: items.length, ...countByStatus(data.tasks) });
            return data.tasks.map((t) => ({ ...t }));
        });
    }

    /**
     * 对草稿应用单笔补丁（建依赖→环检测→字段→状态就绪校验），就地修改 data、失败回软错误不抛。
     * 抽出供单笔/批量复用；顺序敏感——批量内后一笔能看到前一笔的效果。
     */
    private applyPatch(data: TaskFileData, patch: TaskUpdateInput): PatchResult {
        const candidateTasks = data.tasks.map((t) => ({ ...t, blocks: [...t.blocks], blockedBy: [...t.blockedBy] }));
        const target = candidateTasks.find((t) => t.id === patch.taskId);
        if (!target) {
            log.warn('TaskUpdate 引用不存在的 id', { taskId: patch.taskId });
            return { ok: false, message: `任务 ${patch.taskId} 不存在，请先 TaskList 确认 id` };
        }

        // 先在完整候选副本上修改和校验，所有不变量通过后才提交到当前批次草稿。
        const addBlockedBy = (patch.addBlockedBy ?? []).filter((id) => id !== target.id);
        const addBlocks = (patch.addBlocks ?? []).filter((id) => id !== target.id);
        const unknown = [...addBlockedBy, ...addBlocks].find((id) => !candidateTasks.some((t) => t.id === id));
        if (unknown) return { ok: false, message: `依赖引用的任务 ${unknown} 不存在` };

        for (const upId of addBlockedBy) {
            target.blockedBy = mergeUnique(target.blockedBy, [upId]);
            const up = candidateTasks.find((t) => t.id === upId)!;
            up.blocks = mergeUnique(up.blocks, [target.id]);
        }
        for (const downId of addBlocks) {
            target.blocks = mergeUnique(target.blocks, [downId]);
            const down = candidateTasks.find((t) => t.id === downId)!;
            down.blockedBy = mergeUnique(down.blockedBy, [target.id]);
        }
        if ((addBlockedBy.length > 0 || addBlocks.length > 0) && hasCycle(candidateTasks)) {
            return { ok: false, message: '建立该依赖会形成环，已拒绝' };
        }

        if (patch.subject !== undefined) target.subject = patch.subject;
        if (patch.description !== undefined) target.description = patch.description;
        if (patch.activeForm !== undefined) target.activeForm = patch.activeForm;

        if (patch.status !== undefined) {
            if (patch.status === 'in_progress' && !isReady(target, candidateTasks)) {
                const pending = target.blockedBy.filter(
                    (id) => candidateTasks.find((t) => t.id === id)?.status !== 'completed'
                );
                return {
                    ok: false,
                    message: `任务 ${target.id} 被未完成的前置任务 [${pending.join(',')}] 阻塞，请先完成它们`
                };
            }
            target.status = patch.status;
        }

        if (candidateTasks.filter((task) => task.status === 'in_progress').length > 1) {
            return { ok: false, message: '同一时刻最多只能有一个 in_progress 任务' };
        }
        data.tasks = candidateTasks;
        return { ok: true };
    }

    /**
     * 批量按 id 更新（一次可传多笔）：逐笔顺序应用到同一草稿、单次落盘。
     * 动机——弱模型在收尾时想一把关掉多个任务，若 TaskUpdate 只能单改，模型易把 N 笔塌成文本 JSON
     * 而不发真正的 tool call；批量入参让"关闭全部任务"成为一次调用，显著降低该失败。
     * 单笔失败只记入 failed、不影响其余；整批无一生效回 ok:false。
     */
    async updateMany(sessionId: string | undefined, patches: TaskUpdateInput[]): Promise<TaskBatchResult> {
        const key = this.key(sessionId);
        return this.enqueue(key, (data): TaskBatchResult => {
            const failed: { taskId: string; message: string }[] = [];
            for (const patch of patches) {
                const res = this.applyPatch(data, patch);
                if (!res.ok) failed.push({ taskId: patch.taskId, message: res.message });
            }
            if (failed.length === patches.length) {
                return { ok: false, message: failed.map((f) => `#${f.taskId}: ${f.message}`).join('；') };
            }
            const inProgress = data.tasks.filter((t) => t.status === 'in_progress');
            if (inProgress.length > 1) {
                log.warn('存在多个 in_progress 任务', { key, ids: inProgress.map((t) => t.id) });
            }
            log.info('TaskUpdate', {
                key,
                patches: patches.length,
                failed: failed.length,
                ...countByStatus(data.tasks)
            });
            return { ok: true, tasks: data.tasks.map((t) => ({ ...t })), failed };
        });
    }

    /** 删除某会话的任务文件（随会话删除清理，幂等） */
    async delete(sessionId: string): Promise<void> {
        const key = this.key(sessionId);
        await this.enqueue(key, () => undefined).catch(() => {});
        this.cache.delete(key);
        await fs.rm(this.filePath(key), { force: true }).catch(() => {});
    }
}

let store: TaskStore | null = null;

/** 获取任务仓储单例 */
export function createTaskStore(dir: string = paths.tasksDir()): TaskStore {
    return new TaskStore(dir);
}

export function getTaskStore(): TaskStore {
    if (!store) store = createTaskStore();
    return store;
}
