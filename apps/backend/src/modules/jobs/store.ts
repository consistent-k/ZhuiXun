import fs from 'node:fs/promises';

import type { JobCreateRequest, JobStatus, JobView } from '@zhuixun/shared';

import { writeJsonAtomic } from '@/config/atomic-json';
import { paths } from '@/config/paths';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('JobStore');

/** 记录文件版本，便于后续演进。 */
const CURRENT_VERSION = 1;
/** 保留的最近任务条数（终态最旧优先淘汰），避免文件无限增长。 */
export const MAX_JOBS = 50;

/** 后台任务 domain 记录（写入活跃/终态信息，含 aborted 等内部语义）。 */
export interface JobRecord {
    id: string;
    title: string;
    prompt: string;
    ownerSessionId?: string;
    status: JobStatus;
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
    result?: string;
    error?: string;
    steps?: number;
}

interface JobFileData {
    version: number;
    seq: number;
    jobs: JobRecord[];
}

/** domain → 前端视图。 */
export function toJobView(job: JobRecord): JobView {
    return {
        id: job.id,
        title: job.title,
        prompt: job.prompt,
        ownerSessionId: job.ownerSessionId,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        result: job.result,
        error: job.error,
        steps: job.steps
    };
}

/** 终态（不会再变化）。 */
function isTerminal(status: JobStatus): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * 后台任务仓储：`~/.zhuixun/jobs/index.json`，串行队列 + 原子写（对齐 AutomationStore）。
 * 与自动化任务分开：Job 没有调度字段，只有一次性的入队/执行/终态。
 */
export class JobStore {
    private readonly file: string;
    private cache: JobFileData | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(file = paths.jobsFile()) {
        this.file = file;
    }

    private empty(): JobFileData {
        return { version: CURRENT_VERSION, seq: 0, jobs: [] };
    }

    private async load(): Promise<JobFileData> {
        if (this.cache) return this.cache;
        let data = this.empty();
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw) as JobFileData;
            data = { version: CURRENT_VERSION, seq: parsed.seq ?? 0, jobs: parsed.jobs ?? [] };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.error('读取后台任务文件失败，按空清单处理', { err });
            }
        }
        this.cache = data;
        return data;
    }

    private enqueue<T>(fn: (data: JobFileData) => T): Promise<T> {
        const run = this.queue.then(async () => {
            const current = await this.load();
            const draft: JobFileData = JSON.parse(JSON.stringify(current)) as JobFileData;
            const result = fn(draft);
            await writeJsonAtomic(this.file, draft);
            this.cache = draft;
            return result;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    async list(): Promise<JobRecord[]> {
        const data = await this.load();
        // 最新在前（状态页/调试用）
        return [...data.jobs].sort((a, b) => b.createdAt - a.createdAt).map((j) => ({ ...j }));
    }

    async get(id: string): Promise<JobRecord | null> {
        const data = await this.load();
        const found = data.jobs.find((j) => j.id === id);
        return found ? { ...found } : null;
    }

    /** 入队：状态 queued，等 service 的并发泵拉起。 */
    async create(input: JobCreateRequest): Promise<JobRecord> {
        const prompt = input.prompt?.trim();
        if (!prompt) throw new Error('任务指令（prompt）不能为空');
        return this.enqueue((data) => {
            const now = Date.now();
            data.seq += 1;
            const record: JobRecord = {
                id: String(data.seq),
                title: input.title?.trim() || prompt.slice(0, 30),
                prompt,
                ownerSessionId: input.ownerSessionId,
                status: 'queued',
                createdAt: now
            };
            data.jobs.push(record);
            // 有界保留：只淘汰终态里最旧的，排队/运行中的不丢。
            if (data.jobs.length > MAX_JOBS) {
                const overflow = data.jobs.length - MAX_JOBS;
                const removable = data.jobs.filter((j) => isTerminal(j.status)).slice(0, overflow);
                const ids = new Set(removable.map((j) => j.id));
                data.jobs = data.jobs.filter((j) => !ids.has(j.id));
            }
            log.info('JobCreate', { id: record.id, ownerSessionId: record.ownerSessionId });
            return { ...record };
        });
    }

    /** 取最早入队的 queued 任务（FIFO）。 */
    async findNextQueued(): Promise<JobRecord | null> {
        const data = await this.load();
        const next = data.jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
        return next ? { ...next } : null;
    }

    async markRunning(id: string): Promise<JobRecord | null> {
        return this.enqueue((data) => {
            const job = data.jobs.find((j) => j.id === id);
            if (!job || job.status !== 'queued') return null;
            job.status = 'running';
            job.startedAt = Date.now();
            return { ...job };
        });
    }

    /** 结算（成功/失败/取消）。已终态则不覆盖，避免取消后迟到的结果把状态改回去。 */
    async settle(
        id: string,
        patch: { status: JobStatus; result?: string; error?: string; steps?: number }
    ): Promise<JobRecord | null> {
        return this.enqueue((data) => {
            const job = data.jobs.find((j) => j.id === id);
            if (!job || isTerminal(job.status)) return null;
            job.status = patch.status;
            job.endedAt = Date.now();
            if (patch.result !== undefined) job.result = patch.result;
            if (patch.error !== undefined) job.error = patch.error;
            if (patch.steps !== undefined) job.steps = patch.steps;
            return { ...job };
        });
    }

    /**
     * 启动恢复：后台任务不跨进程续跑。上次残留的 running/queued 一律判 failed，
     * 让用户看到「应用退出导致中断」而不是永远卡在执行中。
     */
    async recoverInterrupted(): Promise<void> {
        await this.enqueue((data) => {
            const now = Date.now();
            for (const job of data.jobs) {
                if (job.status === 'running' || job.status === 'queued') {
                    job.status = 'failed';
                    job.endedAt = now;
                    job.error = '应用退出导致后台任务中断';
                }
            }
        });
    }
}

let store: JobStore | null = null;

export function createJobStore(file: string = paths.jobsFile()): JobStore {
    return new JobStore(file);
}

export function getJobStore(): JobStore {
    if (!store) store = createJobStore();
    return store;
}
