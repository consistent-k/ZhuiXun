import { randomUUID } from 'node:crypto';

import type { JobCreateRequest, JobView } from '@zhuixun/shared';

import type { AutomationRunFn } from '@/modules/chat/agents/runner';
import type { IConversationService, StoredMessage } from '@/modules/conversations';
import { createLogger } from '@/platform/logging/index';

import { getJobStore, toJobView, type JobRecord, type JobStore } from './store';

const log = createLogger('JobService');

/** 同时执行的后台任务上限（单用户桌面，保守封顶，避免抢占交互式对话资源）。 */
export const MAX_CONCURRENT_JOBS = 2;

/** 回灌框：让模型知道这是后台任务而不是用户刚刚说的话。 */
const FRAMING = '这是一条来自【后台任务】的指令。请在后台独立完成，不需要向任何人提问：';

/** 完成唤醒语：只要求一句话收尾，避免把长结果整段复述一遍。 */
function wakeText(job: JobRecord, ok: boolean): string {
    const head = `【后台任务${ok ? '已完成' : '失败'}】「${job.title}」`;
    return ok
        ? `${head}已执行完毕，完整结果已写入上一条消息。请用一两句话向用户概括关键结论。`
        : `${head}执行失败：${job.error ?? '未知错误'}。请用一句话告知用户失败原因。`;
}

function textMessage(role: 'user' | 'assistant', content: string): StoredMessage {
    return { id: randomUUID(), role, content, timestamp: Date.now(), parts: [{ type: 'text', text: content }] };
}

/** 后台任务服务的装配依赖（由 bootstrap 注入，模块不直接取 chat 单例）。 */
export interface JobServiceDeps {
    /** 无人值守 headless runner（复用 createAutomationRunAgent）。 */
    runAgent: AutomationRunFn;
    conversations: IConversationService;
    /** 状态变化广播（SSE -> 前端）。 */
    emit: (job: JobView) => void;
    /** 完成唤醒投递（SessionRuntime.deliver）。 */
    deliver: (sessionId: string, text: string, source: 'job') => void;
}

/**
 * 后台任务服务：入队 → 并发泵拉起 → headless 执行 → 结果落库 → 唤醒 owner 会话。
 *
 * 不阻塞调用方（JobStart 工具立即返回 id）；并发上限外的任务保持 queued，
 * 由前一个任务结束后继续拉起。取消通过 AbortController 中止模型流。
 */
export class JobService {
    private readonly running = new Set<string>();
    private readonly controllers = new Map<string, AbortController>();
    private pumping = false;

    constructor(
        private readonly deps: JobServiceDeps,
        private readonly store: JobStore = getJobStore()
    ) {}

    /** 启动时恢复：上次残留的排队/运行任务判失败（后台任务不跨进程续跑）。 */
    async recover(): Promise<void> {
        await this.store.recoverInterrupted();
    }

    async start(input: JobCreateRequest): Promise<JobView> {
        const record = await this.store.create(input);
        this.deps.emit(toJobView(record));
        void this.pump();
        return toJobView(record);
    }

    async list(): Promise<JobView[]> {
        return (await this.store.list()).map(toJobView);
    }

    async get(id: string): Promise<JobView | null> {
        const record = await this.store.get(id);
        return record ? toJobView(record) : null;
    }

    /** 取消：排队中直接置 cancelled；运行中先 abort 模型流。 */
    async cancel(id: string): Promise<JobView | null> {
        this.controllers.get(id)?.abort();
        const settled = await this.store.settle(id, { status: 'cancelled', error: '用户取消' });
        if (settled) {
            this.deps.emit(toJobView(settled));
            log.info('JobCancelled', { id });
            return toJobView(settled);
        }
        return null;
    }

    /** 并发泵：补满执行位；每个任务结束后再拉一次。 */
    private async pump(): Promise<void> {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.running.size < MAX_CONCURRENT_JOBS) {
                const next = await this.store.findNextQueued();
                if (!next) break;
                const claimed = await this.store.markRunning(next.id);
                if (!claimed) continue;
                this.running.add(claimed.id);
                this.deps.emit(toJobView(claimed));
                void this.execute(claimed).finally(() => {
                    this.running.delete(claimed.id);
                    this.controllers.delete(claimed.id);
                    void this.pump();
                });
            }
        } finally {
            this.pumping = false;
        }
    }

    private async execute(job: JobRecord): Promise<void> {
        const conversationId = job.ownerSessionId ?? randomUUID();
        const framed = `${FRAMING}\n\n${job.prompt}`;
        const controller = new AbortController();
        this.controllers.set(job.id, controller);

        // 先落用户侧计划消息：即使执行失败，会话里也能看到这次触发。
        await this.deps.conversations
            .appendMessages(conversationId, [textMessage('user', framed)], { title: job.title })
            .catch((err) => log.warn('写入后台任务触发消息失败（继续执行）', { id: job.id, err }));

        try {
            const result = await this.deps.runAgent(framed, {
                sessionId: conversationId,
                abortSignal: controller.signal
            });
            const text = result.text?.trim() || '（后台任务没有产生文本输出）';
            await this.deps.conversations
                .appendMessages(conversationId, [textMessage('assistant', text)], { title: job.title })
                .catch((err) => log.warn('写入后台任务结果失败', { id: job.id, err }));
            const settled = await this.store.settle(job.id, {
                status: 'succeeded',
                result: text,
                steps: result.steps
            });
            if (settled) {
                this.deps.emit(toJobView(settled));
                this.notify(job, true);
            }
            log.info('JobSucceeded', { id: job.id, conversationId, steps: result.steps });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const cancelled = controller.signal.aborted;
            // 取消时可能已被 cancel() 置终态，settle 会返回 null，不重复广播。
            const settled = await this.store.settle(job.id, {
                status: cancelled ? 'cancelled' : 'failed',
                error: cancelled ? '用户取消' : message
            });
            await this.deps.conversations
                .appendMessages(
                    conversationId,
                    [textMessage('assistant', cancelled ? '后台任务已取消。' : `后台任务执行失败：${message}`)],
                    { title: job.title }
                )
                .catch(() => undefined);
            if (settled) {
                this.deps.emit(toJobView(settled));
                if (!cancelled) this.notify({ ...job, error: message }, false);
            }
            log.error('JobFailed', { id: job.id, cancelled, err: error });
        }
    }

    /** 完成唤醒：owner 会话存在时才投递；busy/节流由 SessionRuntime 决定排队。 */
    private notify(job: JobRecord, ok: boolean): void {
        if (!job.ownerSessionId) return;
        try {
            this.deps.deliver(job.ownerSessionId, wakeText(job, ok), 'job');
        } catch (error) {
            log.warn('后台任务完成唤醒投递失败（忽略）', { id: job.id, err: error });
        }
    }
}

let service: JobService | null = null;

export function createJobService(deps: JobServiceDeps, store?: JobStore): JobService {
    return new JobService(deps, store);
}

export function setJobService(next: JobService): void {
    service = next;
}

export function getJobService(): JobService {
    if (!service) throw new Error('JobService 尚未初始化');
    return service;
}
