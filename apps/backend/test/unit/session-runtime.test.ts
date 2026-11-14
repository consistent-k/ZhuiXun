import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionRuntime, subscribeSessionEvents } from '@/modules/chat';

let runtime: SessionRuntime;

beforeEach(() => {
    runtime = new SessionRuntime();
});

afterEach(() => {
    runtime.reset();
});

/** 让 endTurn 里的 queueMicrotask 排空。 */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SessionRuntime', () => {
    it('忙时投递进 inbox，空闲后只补投一条', async () => {
        const started: string[] = [];
        runtime.setStarter(({ text, sessionId }) => {
            started.push(text);
            runtime.beginTurn(sessionId, 'job');
        });

        runtime.beginTurn('s1', 'user');
        expect(runtime.deliver('s1', 'first', 'job')).toBe('queued');
        expect(runtime.deliver('s1', 'second', 'job')).toBe('queued');
        expect(runtime.inboxSizeOf('s1')).toBe(2);

        runtime.endTurn('s1', 'user', 'completed');
        await flushMicrotasks();
        expect(started).toEqual(['first']);
        expect(runtime.isBusy('s1')).toBe(true);

        runtime.endTurn('s1', 'job', 'completed');
        await flushMicrotasks();
        expect(started).toEqual(['first', 'second']);
    });

    it('连续唤醒达上限后改为排队，真人输入重置预算', async () => {
        const started: string[] = [];
        runtime.setStarter(({ text, sessionId }) => {
            started.push(text);
            runtime.beginTurn(sessionId, 'job');
        });

        // 默认 maxConsecutiveWakes=3：前三条立即开轮，第四条被节流。
        for (let i = 0; i < 3; i += 1) {
            expect(runtime.deliver('s2', `wake-${i}`, 'job')).toBe('started');
            runtime.endTurn('s2', 'job', 'completed');
            await flushMicrotasks();
        }
        expect(runtime.spentWakesOf('s2')).toBe(3);
        expect(runtime.deliver('s2', 'wake-3', 'job')).toBe('queued');
        expect(started).toEqual(['wake-0', 'wake-1', 'wake-2']);

        // 真人输入重置预算；该轮结束后补投排队消息。
        runtime.beginTurn('s2', 'user');
        expect(runtime.spentWakesOf('s2')).toBe(0);
        runtime.endTurn('s2', 'user', 'completed');
        await flushMicrotasks();
        expect(started).toEqual(['wake-0', 'wake-1', 'wake-2', 'wake-3']);
    });

    it('emit turn-start / turn-end / delivery 事件供 SSE 使用', async () => {
        const events: string[] = [];
        const off = subscribeSessionEvents((event) => {
            events.push(event.type);
        });
        runtime.setStarter(({ sessionId }) => runtime.beginTurn(sessionId, 'goal'));
        runtime.beginTurn('s3', 'user');
        runtime.endTurn('s3', 'user', 'completed');
        await flushMicrotasks();
        runtime.deliver('s3', 'round', 'goal');
        off();
        runtime.endTurn('s3', 'goal', 'completed');

        expect(events).toEqual(['turn-start', 'turn-end', 'delivery', 'turn-start']);
    });

    it('bypassThrottle 不受连续唤醒预算限制，也不消耗预算（Goal 专用）', async () => {
        const started: string[] = [];
        runtime.setStarter(({ text, sessionId, source }) => {
            started.push(text);
            runtime.beginTurn(sessionId, source);
        });
        // 先用 Job 唤醒把预算耗尽。
        for (let i = 0; i < 3; i += 1) {
            runtime.deliver('s7', `job-${i}`, 'job');
            runtime.endTurn('s7', 'job', 'completed');
            await flushMicrotasks();
        }
        expect(runtime.deliver('s7', 'job-4', 'job')).toBe('queued');

        expect(runtime.deliver('s7', 'goal-1', 'goal', { bypassThrottle: true })).toBe('started');
        expect(runtime.spentWakesOf('s7')).toBe(3);
    });

    it('starter 同步抛错时回滚唤醒预算', () => {
        runtime.setStarter(() => {
            throw new Error('未就绪');
        });
        expect(runtime.deliver('s4', 'x', 'job')).toBe('started');
        expect(runtime.spentWakesOf('s4')).toBe(0);
    });

    it('isBusy 用计数而非布尔：重复 begin 不会在单次 end 后提前空闲', () => {
        runtime.beginTurn('s5', 'user');
        runtime.beginTurn('s5', 'job');
        runtime.endTurn('s5', 'user', 'completed');
        expect(runtime.isBusy('s5')).toBe(true);
        runtime.endTurn('s5', 'job', 'completed');
        expect(runtime.isBusy('s5')).toBe(false);
    });
});
