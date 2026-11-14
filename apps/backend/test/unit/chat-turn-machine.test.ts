import { describe, expect, it, vi } from 'vitest';

import { TurnMachine } from '@/modules/chat/turn-machine';
import type { TurnPhase } from '@/modules/chat/turn-state';

vi.mock('@/platform/logging/index', () => ({ createLogger: () => ({ debug: vi.fn() }) }));

const activePhases: TurnPhase[] = ['preparing', 'starting', 'compacting', 'streaming', 'finalizing'];

function machineAt(phase: TurnPhase): TurnMachine {
    const machine = new TurnMachine();
    if (phase === 'preparing') return machine;
    machine.start('conversation-1');
    for (const next of ['compacting', 'streaming', 'finalizing', 'completed'] as const) {
        if (machine.phase === phase) break;
        machine.to(next);
    }
    return machine;
}

describe('TurnMachine', () => {
    it('starts preparing and creates new state snapshots along the complete lifecycle', () => {
        const machine = new TurnMachine();
        const initial = machine.state;
        expect(initial).toEqual({ phase: 'preparing' });
        expect(machine.start('conversation-1')).toEqual({ phase: 'starting', chatId: 'conversation-1' });
        expect(initial).toEqual({ phase: 'preparing' });

        for (const phase of ['compacting', 'streaming', 'finalizing', 'completed'] as const) {
            const previous = machine.state;
            const next = machine.to(phase);
            expect(next).toEqual({ phase, chatId: 'conversation-1' });
            expect(next).toBe(machine.state);
            expect(next).not.toBe(previous);
            expect(machine.phase).toBe(phase);
        }
    });

    it('rejects skipped, backward and repeated transitions without replacing state', () => {
        const machine = new TurnMachine();
        const preparing = machine.state;
        expect(() => machine.to('streaming')).toThrow('非法轮次迁移：preparing → streaming');
        expect(machine.state).toBe(preparing);
        machine.start('conversation-1');
        const starting = machine.state;
        for (const next of ['starting', 'preparing', 'completed'] as const) {
            expect(() => machine.to(next)).toThrow(`非法轮次迁移：starting → ${next}`);
            expect(machine.state).toBe(starting);
        }
    });

    it('preserves the existing error unless an explicit replacement is supplied', () => {
        const machine = new TurnMachine();
        machine.to('starting', 'first diagnostic');
        expect(machine.to('compacting').error).toBe('first diagnostic');
        expect(machine.to('streaming', 'replacement').error).toBe('replacement');
        expect(machine.to('finalizing', '').error).toBe('');
    });

    it.each(activePhases)('fails from %s and preserves the first failure on repeat', (phase) => {
        const machine = machineAt(phase);
        const failed = machine.fail(new Error('model rejected request'));
        expect(failed).toMatchObject({ phase: 'failed', error: 'model rejected request' });
        expect(machine.fail(new Error('second failure'))).toBe(failed);
        expect(() => machine.to('finalizing')).toThrow('非法轮次迁移：failed → finalizing');
    });

    it.each([
        ['transport closed', 'transport closed'],
        [null, 'null'],
        [undefined, 'undefined'],
        [42, '42']
    ])('converts non-Error failure %s into %s', (error, expected) => {
        expect(new TurnMachine().fail(error)).toMatchObject({ phase: 'failed', error: expected });
    });

    it.each(activePhases)('aborts from %s and is idempotent on repeat', (phase) => {
        const machine = machineAt(phase);
        const aborted = machine.abort();
        expect(aborted.phase).toBe('aborted');
        expect(machine.abort()).toBe(aborted);
        expect(() => machine.fail('late failure')).toThrow('非法轮次迁移：aborted → failed');
    });

    it('does not change a completed turn on late failure or disconnect', () => {
        const machine = machineAt('completed');
        const completed = machine.state;
        expect(machine.fail(new Error('late failure'))).toBe(completed);
        expect(machine.abort()).toBe(completed);
        expect(() => machine.to('starting')).toThrow('非法轮次迁移：completed → starting');
    });

    it('does not silently turn a failure into an abort', () => {
        const machine = new TurnMachine();
        machine.fail('failed');
        const failed = machine.state;
        expect(() => machine.abort()).toThrow('非法轮次迁移：failed → aborted');
        expect(machine.state).toBe(failed);
    });
});
