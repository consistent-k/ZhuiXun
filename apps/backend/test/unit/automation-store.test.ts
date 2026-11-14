import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AutomationStore } from '@/modules/automation';
import { AUTOMATION_CREATE_LIMIT, createAutomationStore, MISFIRE_GRACE_MS } from '@/modules/automation';

let dir: string;
let store: AutomationStore;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-store-'));
    store = createAutomationStore(path.join(dir, 'index.json'));
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const every = (seconds = 60) => ({ kind: 'every' as const, everySeconds: seconds });
const after = (seconds = 10) => ({ kind: 'after' as const, afterSeconds: seconds });

describe('AutomationStore', () => {
    it('创建时用真实时间锚定 nextRunAt，并拒绝空标题/空指令', async () => {
        const before = Date.now();
        const record = await store.create({ title: '提醒', prompt: '喝水', schedule: after(10) });
        expect(record.nextRunAt).toBeGreaterThanOrEqual(before + 10_000);
        expect(record.lifecycleStatus).toBe('active');
        expect(record.dispatchStatus).toBe('idle');

        await expect(store.create({ title: '  ', prompt: 'x', schedule: after(1) })).rejects.toThrow('标题不能为空');
        await expect(store.create({ title: 'x', prompt: ' ', schedule: after(1) })).rejects.toThrow('不能为空');
    });

    it('创建上限 20 条', async () => {
        for (let i = 0; i < AUTOMATION_CREATE_LIMIT; i += 1) {
            await store.create({ title: `t${i}`, prompt: `p${i}`, schedule: every() });
        }
        await expect(store.create({ title: 'overflow', prompt: 'x', schedule: every() })).rejects.toThrow('上限');
    });

    it('认领 → 结算成功：一次性任务进入 completed，运行台账落 succeeded', async () => {
        const record = await store.create({ title: '一次性', prompt: 'p', schedule: after(1) });
        const runId = `${record.id}:${record.nextRunAt}`;
        const claimed = await store.claim(record.id, runId, record.nextRunAt!);
        expect(claimed?.dispatchStatus).toBe('claimed');

        await store.markRunning(record.id);
        const settled = await store.settle(record.id, runId, {
            outcome: 'succeeded',
            conversationId: 'conv-1',
            steps: 3
        });
        expect(settled?.lifecycleStatus).toBe('completed');
        expect(settled?.dispatchStatus).toBe('idle');
        expect(settled?.nextRunAt).toBeUndefined();

        const runs = await store.listRuns(record.id);
        expect(runs[0]).toMatchObject({ runId, outcome: 'succeeded', conversationId: 'conv-1', steps: 3 });
    });

    it('失败按指数退避重试，超过次数后一次性任务判 failed', async () => {
        const record = await store.create({ title: '会失败', prompt: 'p', schedule: after(1) });
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            const runId = `${record.id}:${attempt}`;
            await store.claim(record.id, runId, Date.now());
            const current = (await store.settle(record.id, runId, { outcome: 'failed', error: 'boom' }))!;
            expect(current.lifecycleStatus).toBe('active');
            expect(current.dispatchAttempts).toBe(attempt);
            expect(current.retryAt).toBeGreaterThan(Date.now());
        }
        const runId = `${record.id}:5`;
        await store.claim(record.id, runId, Date.now());
        const failed = await store.settle(record.id, runId, { outcome: 'failed', error: 'boom' });
        expect(failed?.lifecycleStatus).toBe('failed');
        expect(failed?.lastError).toBe('boom');
        expect(failed?.retryAt).toBeUndefined();
    });

    it('misfire：一次性任务跳过并判 completed，周期任务跳到下一次计划', async () => {
        const oneShot = await store.create({ title: '错过', prompt: 'p', schedule: after(1) });
        const skippedOneShot = await store.skipMisfire(oneShot.id);
        expect(skippedOneShot?.lifecycleStatus).toBe('completed');
        expect(skippedOneShot?.nextRunAt).toBeUndefined();
        expect((await store.listRuns(oneShot.id))[0].error).toContain('misfire');

        const periodic = await store.create({ title: '周期', prompt: 'p', schedule: every(60) });
        const before = Date.now();
        const skippedPeriodic = await store.skipMisfire(periodic.id);
        expect(skippedPeriodic?.lifecycleStatus).toBe('active');
        expect(skippedPeriodic?.nextRunAt).toBeGreaterThan(before);
        expect(MISFIRE_GRACE_MS).toBe(5 * 60_000);
    });

    it('编辑/启停会重算 nextRunAt 并清空退避', async () => {
        const record = await store.create({ title: 't', prompt: 'p', schedule: every(60) });
        const disabled = await store.setEnabled(record.id, false);
        expect(disabled.lifecycleStatus).toBe('paused');
        expect(disabled.nextRunAt).toBeUndefined();

        const enabled = await store.setEnabled(record.id, true);
        expect(enabled.lifecycleStatus).toBe('active');
        expect(enabled.nextRunAt).toBeGreaterThan(Date.now());

        const updated = await store.update(record.id, { title: '新标题', schedule: after(30) });
        expect(updated.title).toBe('新标题');
        expect(updated.schedule).toEqual(after(30));
    });

    it('启动恢复把残留 claimed/running 置回 idle，并把运行台账标 stopped', async () => {
        const record = await store.create({ title: '中断', prompt: 'p', schedule: every(60) });
        const runId = `${record.id}:${record.nextRunAt}`;
        await store.claim(record.id, runId, record.nextRunAt!);
        await store.markRunning(record.id);

        await store.recoverInterrupted();
        const recovered = await store.get(record.id);
        expect(recovered?.dispatchStatus).toBe('idle');
        expect((await store.listRuns(record.id))[0].outcome).toBe('stopped');
    });

    it('findDue / earliestWake 只挑可调度任务', async () => {
        const idle = await store.create({ title: 'idle', prompt: 'p', schedule: every(60) });
        await store.requestRunNow(idle.id);
        const due = await store.findDue(Date.now() + 1);
        expect(due.map((r) => r.id)).toContain(idle.id);
        expect(await store.earliestWake()).toBeLessThanOrEqual(Date.now() + 1);
    });

    it('删除后不可再读', async () => {
        const record = await store.create({ title: 't', prompt: 'p', schedule: every(60) });
        await store.delete(record.id);
        expect(await store.get(record.id)).toBeNull();
    });
});
