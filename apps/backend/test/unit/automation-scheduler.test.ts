import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    automationEvents,
    createAutomationStore,
    createScheduler,
    flushAutomationAudit,
    type AutomationDispatchDeps,
    type AutomationStore
} from '@/modules/automation';

let dir: string;
let store: AutomationStore;
let scheduler: ReturnType<typeof createScheduler> | undefined;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-scheduler-'));
    store = createAutomationStore(path.join(dir, 'index.json'));
});

afterEach(async () => {
    await scheduler?.dispose();
    scheduler = undefined;
    await fs.rm(dir, { recursive: true, force: true });
});

/** 等一个 settle 事件（带超时，避免调度器 bug 把测试挂死）。 */
function waitSettle(automationId: string, timeoutMs = 2000): Promise<{ outcome: string; conversationId?: string }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error('等待 settle 超时'));
        }, timeoutMs);
        const unsubscribe = automationEvents.subscribe((event) => {
            if (event.type === 'settle' && event.automationId === automationId) {
                clearTimeout(timer);
                unsubscribe();
                resolve({ outcome: event.outcome, conversationId: event.conversationId });
            }
        });
    });
}

function deps(result: Awaited<ReturnType<AutomationDispatchDeps['runAgent']>> = { text: 'ok', steps: 2 }) {
    const runAgent = vi.fn(async () => result);
    const appendMessages = vi.fn(async () => ({}));
    return {
        runAgent,
        appendMessages,
        deps: {
            runAgent,
            conversations: { appendMessages }
        } as unknown as AutomationDispatchDeps
    } as const;
}

describe('AutomationScheduler', () => {
    it('到点认领 → 派发 → 结算成功（一次性任务 completed）', async () => {
        const fake = deps();
        const record = await store.create({
            title: '马上跑',
            prompt: '执行',
            schedule: { kind: 'after', afterSeconds: 1 }
        });
        await store.requestRunNow(record.id);

        scheduler = createScheduler(store, fake.deps);
        await scheduler.start();
        const settled = await waitSettle(record.id);

        expect(settled.outcome).toBe('succeeded');
        expect(fake.runAgent).toHaveBeenCalledOnce();
        const after = await store.get(record.id);
        expect(after?.lifecycleStatus).toBe('completed');
        expect(after?.lastRunAt).toBeTypeOf('number');

        // 审计写入是异步队列：flush 确认不会阻塞/抛错（落盘位置由测试沙箱 HOME 决定）。
        await expect(flushAutomationAudit()).resolves.toBeUndefined();
    });

    it('执行失败会写 lastError 并安排退避重试', async () => {
        const fake = deps();
        // dispatch 内部捕获异常并转 failed；让 runAgent 抛错模拟失败。
        fake.runAgent.mockRejectedValueOnce(new Error('模型不可用'));
        const record = await store.create({
            title: '会失败',
            prompt: '执行',
            schedule: { kind: 'every', everySeconds: 60 }
        });
        await store.requestRunNow(record.id);

        scheduler = createScheduler(store, fake.deps);
        await scheduler.start();
        const settled = await waitSettle(record.id);

        expect(settled.outcome).toBe('failed');
        const after = await store.get(record.id);
        expect(after?.lastError).toContain('模型不可用');
        expect(after?.retryAt).toBeGreaterThan(Date.now());
        expect(after?.lifecycleStatus).toBe('active');
    });

    it('启动时跳过已错过窗口的一次性任务（misfire）', async () => {
        // 构造一个 10 分钟前就该跑的一次性任务：直接改文件比等真实时间可靠。
        const record = await store.create({
            title: '过期',
            prompt: '执行',
            schedule: { kind: 'at', at: Date.now() + 60_000 }
        });
        await store.requestRunNow(record.id);
        // requestRunNow 把时间拉到 now；手工再把它推到 10 分钟前。
        const file = path.join(dir, 'index.json');
        const data = JSON.parse(await fs.readFile(file, 'utf8')) as {
            automations: Array<{ id: string; nextRunAt: number }>;
        };
        const target = data.automations.find((a) => a.id === record.id);
        if (!target) throw new Error('任务未落盘');
        target.nextRunAt = Date.now() - 10 * 60_000;
        await fs.writeFile(file, JSON.stringify(data), 'utf8');

        const fresh = createAutomationStore(file);
        const fake = deps();
        scheduler = createScheduler(fresh, fake.deps);
        await scheduler.start();

        await vi.waitFor(async () => {
            const after = await fresh.get(record.id);
            expect(after?.lifecycleStatus).toBe('completed');
        });
        expect(fake.runAgent).not.toHaveBeenCalled();
        const runs = await fresh.listRuns(record.id);
        expect(runs[0].outcome).toBe('stopped');
    });
});
