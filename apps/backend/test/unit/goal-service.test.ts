import type { GoalView } from '@zhuixun/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GoalService, type GoalServiceDeps, type GoalTurnEndEvent } from '@/modules/goal';

type IdleListener = (sessionId: string) => void;
type TurnEndListener = (event: GoalTurnEndEvent) => void;

function makeService(overrides: Partial<GoalServiceDeps> = {}) {
    const idleListeners = new Set<IdleListener>();
    const turnEndListeners = new Set<TurnEndListener>();
    const delivered: Array<{ sessionId: string; text: string; source: string }> = [];
    const emitted: GoalView[] = [];
    let busy = false;
    let deliverResult: 'started' | 'queued' = 'started';
    let lastText: string | undefined;

    const deps: GoalServiceDeps = {
        onIdle: (fn) => {
            idleListeners.add(fn);
            return () => idleListeners.delete(fn);
        },
        onTurnEnd: (fn) => {
            turnEndListeners.add(fn);
            return () => turnEndListeners.delete(fn);
        },
        isBusy: () => busy,
        deliver: (sessionId, text, source) => {
            delivered.push({ sessionId, text, source });
            busy = deliverResult === 'started';
            return deliverResult;
        },
        emit: (goal) => emitted.push(goal),
        readLastAssistantText: async () => lastText,
        ...overrides
    };

    const service = new GoalService(deps);
    service.start();
    return {
        service,
        delivered,
        emitted,
        setIdle: (value: boolean) => {
            busy = value;
        },
        setDeliverResult: (value: 'started' | 'queued') => {
            deliverResult = value;
        },
        setLastText: (value: string | undefined) => {
            lastText = value;
        },
        /** 模拟一轮结束并触发 idle（顺序与 SessionRuntime 一致：turn-end 先于 idle）。 */
        finishRound: async (sessionId: string) => {
            busy = false;
            for (const fn of turnEndListeners) fn({ sessionId, source: 'goal', outcome: 'completed' });
            for (const fn of idleListeners) fn(sessionId);
            // handleTurnEnd 会等 100ms 让落库完成后再检查并推进，这里留足余量。
            await new Promise((resolve) => setTimeout(resolve, 180));
        }
    };
}

describe('GoalService', () => {
    let harness: ReturnType<typeof makeService>;

    beforeEach(() => {
        harness = makeService();
    });

    afterEach(() => {
        harness.service.dispose();
    });

    it('arm 后立即推进第一轮，prompt 带轮次与原始目标', () => {
        const view = harness.service.arm('s1', '把报告写完', 3);
        // arm 时若空闲会同步开第一轮，返回的视图已是 running。
        expect(view).toMatchObject({ status: 'running', roundsStarted: 1, maxRounds: 3 });
        expect(harness.delivered).toHaveLength(1);
        expect(harness.delivered[0].text).toContain('<goal_round round="1" max="3">');
        expect(harness.delivered[0].text).toContain('把报告写完');
        expect(harness.service.get('s1')?.roundsStarted).toBe(1);
    });

    it('每轮结束后自动推进下一轮，达上限后 blocked', async () => {
        harness.service.arm('s2', '目标', 2);
        expect(harness.service.get('s2')?.status).toBe('running');
        await harness.finishRound('s2');
        expect(harness.delivered).toHaveLength(2);
        expect(harness.service.get('s2')?.roundsStarted).toBe(2);

        await harness.finishRound('s2');
        expect(harness.delivered).toHaveLength(2);
        expect(harness.service.get('s2')).toMatchObject({ status: 'blocked' });
        expect(harness.service.get('s2')?.note).toContain('最大轮数');
    });

    it('回复包含 <goal_done> 时视为完成并 block', async () => {
        harness.setLastText('完成了 <goal_done>');
        harness.service.arm('s3', '目标', 5);
        await harness.finishRound('s3');
        expect(harness.service.get('s3')).toMatchObject({ status: 'blocked', note: '目标已完成' });
    });

    it('投递被节流时回退本轮计数并回到 armed', () => {
        harness.setDeliverResult('queued');
        harness.service.arm('s4', '目标', 3);
        const view = harness.service.get('s4');
        expect(view?.roundsStarted).toBe(0);
        expect(view?.status).toBe('armed');
        expect(view?.note).toContain('节流');
    });

    it('disarm 后不再推进；re-arm 从 0 轮开始', () => {
        harness.service.arm('s5', '目标', 3);
        harness.service.disarm('s5');
        expect(harness.service.get('s5')?.status).toBe('disarmed');

        const rearmed = harness.service.arm('s5', '新目标', 2);
        expect(rearmed).toMatchObject({ status: 'armed', roundsStarted: 0, goal: '新目标' });
    });

    it('maxRounds 超过硬上限会被截断', () => {
        const view = harness.service.arm('s6', '目标', 999);
        expect(view.maxRounds).toBe(50);
    });
});
