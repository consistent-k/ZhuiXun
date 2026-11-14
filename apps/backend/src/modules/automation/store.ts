import fs from 'node:fs/promises';

import type {
    AutomationCreateRequest,
    AutomationRunOutcome,
    AutomationRunView,
    AutomationUpdateRequest,
    AutomationView
} from '@zhuixun/shared';

import { writeJsonAtomic } from '@/config/atomic-json';
import { paths } from '@/config/paths';
import { createLogger } from '@/platform/logging/index';

import { computeNextRunAt, isOneShot, validateSchedule } from './cron';

const log = createLogger('Automation');

/** 序列化版本，便于后续演进文件结构。 */
const CURRENT_VERSION = 1;
/** 创建上限（§11 决策：对齐 ZCode 的 20 条）。 */
export const AUTOMATION_CREATE_LIMIT = 20;
/** 每任务保留的近期运行台账条数（有界，避免 index.json 无限膨胀）。 */
const MAX_RECENT_RUNS = 50;
/** 失败重试上限；超过后周期任务跳到下次计划、一次性任务判 failed。 */
const MAX_ATTEMPTS = 5;
/** 失败退避基数与上限。 */
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 60 * 60_000;
/** 错过触发窗口（misfire）宽限：超过则一次性丢弃、周期跳过（§11 决策，固定值不暴露配置）。 */
export const MISFIRE_GRACE_MS = 5 * 60_000;

/** 单次运行台账（domain）。 */
export interface AutomationRunRecord {
    runId: string;
    scheduledAt: number;
    startedAt?: number;
    endedAt?: number;
    outcome: AutomationRunOutcome;
    conversationId?: string;
    error?: string;
    steps?: number;
}

/**
 * 任务 domain 记录（后端内部，含调度细节）。对外经 toView 脱敏成 AutomationView，
 * dispatchAttempts / retryAt / recentRuns 等刻意不进 shared 契约。
 */
export interface AutomationRecord {
    id: string;
    title: string;
    prompt: string;
    schedule: AutomationView['schedule'];
    sessionId?: string;
    enabled: boolean;
    lifecycleStatus: AutomationView['lifecycleStatus'];
    dispatchStatus: AutomationView['dispatchStatus'];
    nextRunAt?: number;
    lastRunAt?: number;
    lastError?: string;
    dispatchAttempts: number;
    retryAt?: number;
    createdAt: number;
    updatedAt: number;
    recentRuns: AutomationRunRecord[];
}

/** 单次结算入参。 */
export interface AutomationSettleInput {
    outcome: AutomationRunOutcome;
    conversationId?: string;
    error?: string;
    steps?: number;
}

interface AutomationFileData {
    version: number;
    seq: number;
    automations: AutomationRecord[];
}

/** domain → 前端视图。 */
export function toView(r: AutomationRecord): AutomationView {
    return {
        id: r.id,
        title: r.title,
        prompt: r.prompt,
        schedule: r.schedule,
        enabled: r.enabled,
        lifecycleStatus: r.lifecycleStatus,
        dispatchStatus: r.dispatchStatus,
        sessionId: r.sessionId,
        nextRunAt: r.nextRunAt,
        lastRunAt: r.lastRunAt,
        lastError: r.lastError,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
    };
}

/** 运行记录 → 前端视图。 */
export function toRunView(automationId: string, run: AutomationRunRecord): AutomationRunView {
    return {
        runId: run.runId,
        automationId,
        scheduledAt: run.scheduledAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        outcome: run.outcome,
        conversationId: run.conversationId,
        error: run.error,
        steps: run.steps
    };
}

// PLACEHOLDER_STORE

/**
 * 自动化任务仓储：全部定义 + 近期台账落单文件 `~/.zhuixun/automations/index.json`（跨会话）。
 * 写操作走串行队列 + 原子写（临时文件 rename），范式对齐 modules/tasks 的 TaskStore。
 */
export class AutomationStore {
    private readonly file: string;
    private cache: AutomationFileData | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(file = paths.automationsFile()) {
        this.file = file;
    }

    private empty(): AutomationFileData {
        return { version: CURRENT_VERSION, seq: 0, automations: [] };
    }

    private async load(): Promise<AutomationFileData> {
        if (this.cache) return this.cache;
        let data = this.empty();
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw) as AutomationFileData;
            data = { version: CURRENT_VERSION, seq: parsed.seq ?? 0, automations: parsed.automations ?? [] };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.error('读取自动化任务文件失败，按空清单处理', { err });
            }
        }
        this.cache = data;
        return data;
    }

    /** 串行化「读-改-写」：深拷贝草稿，持久化成功后才提交缓存，避免写盘失败留脏缓存。 */
    private enqueue<T>(fn: (data: AutomationFileData) => T): Promise<T> {
        const run = this.queue.then(async () => {
            const current = await this.load();
            const draft: AutomationFileData = JSON.parse(JSON.stringify(current)) as AutomationFileData;
            const result = fn(draft);
            await writeJsonAtomic(this.file, draft);
            this.cache = draft;
            return result;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** 读取全部任务快照。 */
    async list(): Promise<AutomationRecord[]> {
        const data = await this.load();
        return data.automations.map((a) => ({ ...a }));
    }

    async get(id: string): Promise<AutomationRecord | null> {
        const data = await this.load();
        const found = data.automations.find((a) => a.id === id);
        return found ? { ...found } : null;
    }

    /** 创建任务：校验规则、校验上限、算 nextRunAt。 */
    async create(input: AutomationCreateRequest): Promise<AutomationRecord> {
        validateSchedule(input.schedule);
        const title = input.title?.trim();
        const prompt = input.prompt?.trim();
        if (!title) throw new Error('标题不能为空');
        if (!prompt) throw new Error('任务指令（prompt）不能为空');
        return this.enqueue((data) => {
            if (data.automations.length >= AUTOMATION_CREATE_LIMIT) {
                throw new Error(`自动化任务数量已达上限 ${AUTOMATION_CREATE_LIMIT} 条，请先删除无用任务`);
            }
            const now = Date.now();
            data.seq += 1;
            const enabled = input.enabled ?? true;
            const record: AutomationRecord = {
                id: String(data.seq),
                title,
                prompt,
                schedule: input.schedule,
                sessionId: input.sessionId,
                enabled,
                lifecycleStatus: 'active',
                dispatchStatus: 'idle',
                nextRunAt: enabled ? computeNextRunAt(input.schedule, now) : undefined,
                dispatchAttempts: 0,
                createdAt: now,
                updatedAt: now,
                recentRuns: []
            };
            data.automations.push(record);
            log.info('AutomationCreate', { id: record.id, kind: input.schedule.kind, nextRunAt: record.nextRunAt });
            return { ...record };
        });
    }

    /** 编辑任务：schedule 变更或重新启用时重算 nextRunAt。 */
    async update(id: string, patch: AutomationUpdateRequest): Promise<AutomationRecord> {
        if (patch.schedule) validateSchedule(patch.schedule);
        return this.enqueue((data) => {
            const r = data.automations.find((a) => a.id === id);
            if (!r) throw new Error(`任务 ${id} 不存在`);
            const now = Date.now();
            if (patch.title !== undefined) r.title = patch.title.trim();
            if (patch.prompt !== undefined) r.prompt = patch.prompt.trim();
            if (patch.schedule !== undefined) r.schedule = patch.schedule;
            if (patch.enabled !== undefined) r.enabled = patch.enabled;
            // 编辑后任务回到可调度态：清退避、重算下次时间（停用则不排）。
            r.lifecycleStatus = r.enabled ? 'active' : 'paused';
            r.dispatchAttempts = 0;
            r.retryAt = undefined;
            r.nextRunAt = r.enabled ? computeNextRunAt(r.schedule, now) : undefined;
            r.updatedAt = now;
            log.info('AutomationUpdate', { id, enabled: r.enabled, nextRunAt: r.nextRunAt });
            return { ...r };
        });
    }

    /** 启停：启用时重算 nextRunAt 并回到 active，停用时置 paused 并清 nextRunAt。 */
    async setEnabled(id: string, enabled: boolean): Promise<AutomationRecord> {
        return this.enqueue((data) => {
            const r = data.automations.find((a) => a.id === id);
            if (!r) throw new Error(`任务 ${id} 不存在`);
            const now = Date.now();
            r.enabled = enabled;
            r.lifecycleStatus = enabled ? 'active' : 'paused';
            r.dispatchAttempts = 0;
            r.retryAt = undefined;
            r.nextRunAt = enabled ? computeNextRunAt(r.schedule, now) : undefined;
            r.updatedAt = now;
            return { ...r };
        });
    }

    async delete(id: string): Promise<void> {
        await this.enqueue((data) => {
            data.automations = data.automations.filter((a) => a.id !== id);
        });
    }

    // PLACEHOLDER_SCHED

    /** 可被调度的任务：启用、active、空闲，且到了 nextRunAt 或退避 retryAt。 */
    async findDue(now: number): Promise<AutomationRecord[]> {
        const data = await this.load();
        return data.automations
            .filter(
                (a) =>
                    a.enabled &&
                    a.lifecycleStatus === 'active' &&
                    a.dispatchStatus === 'idle' &&
                    ((a.retryAt !== undefined && a.retryAt <= now) ||
                        (a.retryAt === undefined && a.nextRunAt !== undefined && a.nextRunAt <= now))
            )
            .map((a) => ({ ...a }));
    }

    /** 最近一次应唤醒的时间（取所有可调度任务的 min(retryAt ?? nextRunAt)）；无则 undefined。 */
    async earliestWake(): Promise<number | undefined> {
        const data = await this.load();
        let min: number | undefined;
        for (const a of data.automations) {
            if (!a.enabled || a.lifecycleStatus !== 'active' || a.dispatchStatus !== 'idle') continue;
            const at = a.retryAt ?? a.nextRunAt;
            if (at === undefined) continue;
            if (min === undefined || at < min) min = at;
        }
        return min;
    }

    /** 认领：置 claimed 并落一条 running 台账（single-flight 的持久化侧标记）。 */
    async claim(id: string, runId: string, scheduledAt: number): Promise<AutomationRecord | null> {
        return this.enqueue((data) => {
            const r = data.automations.find((a) => a.id === id);
            if (!r || r.dispatchStatus !== 'idle') return null;
            const now = Date.now();
            r.dispatchStatus = 'claimed';
            r.updatedAt = now;
            r.recentRuns.unshift({ runId, scheduledAt, startedAt: now, outcome: 'running' });
            if (r.recentRuns.length > MAX_RECENT_RUNS) r.recentRuns.length = MAX_RECENT_RUNS;
            return { ...r };
        });
    }

    /** 标记开始执行（claimed → running）。 */
    async markRunning(id: string): Promise<void> {
        await this.enqueue((data) => {
            const r = data.automations.find((a) => a.id === id);
            if (r) {
                r.dispatchStatus = 'running';
                r.updatedAt = Date.now();
            }
        });
    }

    /** 结算一次运行：更新台账 + 推进生命周期/下次时间/退避。 */
    async settle(id: string, runId: string, result: AutomationSettleInput): Promise<AutomationRecord | null> {
        return this.enqueue((data) => {
            const r = data.automations.find((a) => a.id === id);
            if (!r) return null;
            const now = Date.now();
            const run = r.recentRuns.find((x) => x.runId === runId);
            if (run) {
                run.outcome = result.outcome;
                run.endedAt = now;
                run.conversationId = result.conversationId;
                run.error = result.error;
                run.steps = result.steps;
            }
            r.lastRunAt = now;
            r.dispatchStatus = 'idle';
            const oneShot = isOneShot(r.schedule.kind);

            if (result.outcome === 'succeeded') {
                r.dispatchAttempts = 0;
                r.retryAt = undefined;
                r.lastError = undefined;
                if (oneShot) {
                    r.lifecycleStatus = 'completed';
                    r.nextRunAt = undefined;
                } else {
                    r.nextRunAt = computeNextRunAt(r.schedule, now);
                    if (r.nextRunAt === undefined) r.lifecycleStatus = 'completed';
                }
            } else {
                r.lastError = result.error ?? '执行失败';
                r.dispatchAttempts += 1;
                if (r.dispatchAttempts < MAX_ATTEMPTS) {
                    // 退避重试：指数退避封顶，lifecycle 仍 active。
                    const backoff = Math.min(RETRY_BASE_MS * 2 ** (r.dispatchAttempts - 1), RETRY_CAP_MS);
                    r.retryAt = now + backoff;
                } else if (oneShot) {
                    r.lifecycleStatus = 'failed';
                    r.nextRunAt = undefined;
                    r.retryAt = undefined;
                } else {
                    // 周期任务：放弃本次，跳到下一次计划，重置重试计数。
                    r.dispatchAttempts = 0;
                    r.retryAt = undefined;
                    r.nextRunAt = computeNextRunAt(r.schedule, now);
                }
            }
            r.updatedAt = now;
            return { ...r };
        });
    }

    /**
     * 错过触发窗口（misfire）处理（§11 决策：固定 5min 宽限）：一次性任务超宽限直接判终态丢弃，
     * 周期任务跳到下一次计划、不补跑。记一条 stopped 台账供回溯。返回更新后的记录（无则 null）。
     */
    async skipMisfire(id: string): Promise<AutomationRecord | null> {
        return this.enqueue((data) => {
            const r = data.automations.find((a) => a.id === id);
            if (!r) return null;
            const now = Date.now();
            const scheduledAt = r.nextRunAt ?? now;
            r.recentRuns.unshift({
                runId: `${id}:${scheduledAt}`,
                scheduledAt,
                startedAt: now,
                endedAt: now,
                outcome: 'stopped',
                error: '错过触发窗口（misfire），已跳过'
            });
            if (r.recentRuns.length > MAX_RECENT_RUNS) r.recentRuns.length = MAX_RECENT_RUNS;
            if (isOneShot(r.schedule.kind)) {
                r.lifecycleStatus = 'completed';
                r.nextRunAt = undefined;
            } else {
                r.nextRunAt = computeNextRunAt(r.schedule, now);
            }
            r.dispatchStatus = 'idle';
            r.updatedAt = now;
            return { ...r };
        });
    }

    /** 立即运行：把 nextRunAt 拉到现在、清退避，交给下一轮 drive 认领。 */
    async requestRunNow(id: string): Promise<AutomationRecord> {
        return this.enqueue((data) => {
            const r = data.automations.find((a) => a.id === id);
            if (!r) throw new Error(`任务 ${id} 不存在`);
            if (!r.enabled) throw new Error('任务已停用，无法立即运行');
            r.nextRunAt = Date.now();
            r.retryAt = undefined;
            r.lifecycleStatus = 'active';
            r.updatedAt = Date.now();
            return { ...r };
        });
    }

    /** 启动恢复：把上次残留的 claimed/running 安全置回 idle，残留 running 台账标 stopped。 */
    async recoverInterrupted(): Promise<void> {
        await this.enqueue((data) => {
            const now = Date.now();
            for (const r of data.automations) {
                if (r.dispatchStatus === 'claimed' || r.dispatchStatus === 'running') {
                    r.dispatchStatus = 'idle';
                    r.updatedAt = now;
                    const running = r.recentRuns.find((x) => x.outcome === 'running');
                    if (running) {
                        running.outcome = 'stopped';
                        running.endedAt = now;
                    }
                }
            }
        });
    }

    /** 近期运行台账（最新在前）。 */
    async listRuns(id: string): Promise<AutomationRunRecord[]> {
        const r = await this.get(id);
        return r ? r.recentRuns.map((x) => ({ ...x })) : [];
    }
}

let store: AutomationStore | null = null;

export function createAutomationStore(file: string = paths.automationsFile()): AutomationStore {
    return new AutomationStore(file);
}

export function getAutomationStore(): AutomationStore {
    if (!store) store = createAutomationStore();
    return store;
}
