import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JobView } from '@zhuixun/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutomationRunFn } from '@/modules/chat/agents/runner';
import { createJobService, createJobStore, type JobStore } from '@/modules/jobs';

let dir: string;
let store: JobStore;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-'));
    store = createJobStore(path.join(dir, 'index.json'));
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

function waitForStatus(service: { get: (id: string) => Promise<JobView | null> }, id: string, statuses: string[]) {
    return vi.waitFor(
        async () => {
            const job = await service.get(id);
            expect(statuses).toContain(job?.status);
            return job;
        },
        { timeout: 2000, interval: 20 }
    );
}

function makeService(runAgent: AutomationRunFn) {
    const events: JobView[] = [];
    const deliveries: Array<{ sessionId: string; text: string }> = [];
    const appendMessages = vi.fn(async () => ({}));
    const service = createJobService(
        {
            runAgent,
            conversations: { appendMessages } as never,
            emit: (job) => events.push(job),
            deliver: (sessionId, text) => {
                deliveries.push({ sessionId, text });
            }
        },
        store
    );
    return { service, events, deliveries, appendMessages };
}

describe('JobService', () => {
    it('start 立即返回 queued，后台执行成功后落库并唤醒 owner 会话', async () => {
        const runAgent = vi.fn(async () => ({ text: '整理完成', steps: 4 }));
        const { service, events, deliveries, appendMessages } = makeService(runAgent);

        const job = await service.start({ title: '整理资料', prompt: '整理这些资料', ownerSessionId: 's1' });
        expect(['queued', 'running']).toContain(job.status);

        const settled = await waitForStatus(service, job.id, ['succeeded']);
        expect(settled?.result).toBe('整理完成');
        expect(runAgent).toHaveBeenCalledOnce();
        expect(appendMessages).toHaveBeenCalledTimes(2);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0].sessionId).toBe('s1');
        expect(deliveries[0].text).toContain('后台任务已完成');
        expect(events.some((e) => e.status === 'running')).toBe(true);
        expect(events.some((e) => e.status === 'succeeded')).toBe(true);
    });

    it('无 owner 会话时只落库不唤醒', async () => {
        const runAgent = vi.fn(async () => ({ text: 'done', steps: 1 }));
        const { service, deliveries } = makeService(runAgent);
        const job = await service.start({ title: 'no-owner', prompt: 'p' });
        await waitForStatus(service, job.id, ['succeeded']);
        expect(deliveries).toHaveLength(0);
    });

    it('执行失败置 failed 并带错误信息', async () => {
        const runAgent = vi.fn(async () => {
            throw new Error('模型不可用');
        });
        const { service, events } = makeService(runAgent);
        const job = await service.start({ title: '失败', prompt: 'p' });
        const settled = await waitForStatus(service, job.id, ['failed']);
        expect(settled?.error).toContain('模型不可用');
        expect(events.some((e) => e.status === 'failed')).toBe(true);
    });

    it('取消排队中的任务', async () => {
        // 占满执行位：两个长跑任务挂着不结束。
        const blockers: Array<() => void> = [];
        const runAgent = vi.fn(
            () =>
                new Promise<{ text: string; steps: number }>((resolve) => {
                    blockers.push(() => resolve({ text: 'ok', steps: 1 }));
                })
        );
        const { service } = makeService(runAgent);
        const first = await service.start({ title: 'a', prompt: 'a' });
        const second = await service.start({ title: 'b', prompt: 'b' });
        const third = await service.start({ title: 'c', prompt: 'c' });

        const cancelled = await service.cancel(third.id);
        expect(cancelled?.status).toBe('cancelled');

        blockers.forEach((release) => release());
        await waitForStatus(service, first.id, ['succeeded']);
        await waitForStatus(service, second.id, ['succeeded']);
    });

    it('启动恢复把残留 running/queued 判为失败', async () => {
        await store.create({ title: '残留', prompt: 'p' });
        await store.recoverInterrupted();
        const [job] = await store.list();
        expect(job.status).toBe('failed');
        expect(job.error).toContain('中断');
    });
});
