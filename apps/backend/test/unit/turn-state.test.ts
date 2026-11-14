import { describe, expect, it } from 'vitest';

import { canTransition, createTurnState } from '@/modules/chat/turn-state';

describe('turn state transitions', () => {
    it('starts in preparing', () => {
        expect(createTurnState()).toEqual({ phase: 'preparing' });
    });

    it('allows the normal lifecycle and terminal failure paths', () => {
        expect(canTransition('preparing', 'starting')).toBe(true);
        expect(canTransition('starting', 'compacting')).toBe(true);
        expect(canTransition('compacting', 'streaming')).toBe(true);
        expect(canTransition('streaming', 'finalizing')).toBe(true);
        expect(canTransition('finalizing', 'completed')).toBe(true);
        expect(canTransition('streaming', 'failed')).toBe(true);
        expect(canTransition('preparing', 'completed')).toBe(false);
        expect(canTransition('completed', 'starting')).toBe(false);
    });
});
