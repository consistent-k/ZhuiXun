import type { ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStepCompactor } from '@/agent/compaction/step-compactor';
import type { ResolvedModel } from '@/config/types';

const settings = vi.hoisted(() => ({ autoCompactEnabled: true, autoCompactThreshold: 80 }));
vi.mock('@/config/settings-store', () => ({ getAppSettings: () => settings }));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

const model: ResolvedModel = {
    kind: 'openai-compatible',
    modelName: 'fake',
    apiKey: '',
    baseURL: 'https://unused.invalid',
    contextWindow: 100_000
};

function toolHistory(): ModelMessage[] {
    return [
        { role: 'user', content: 'task' },
        {
            role: 'assistant',
            content: [
                { type: 'reasoning', text: 'old private reasoning' },
                { type: 'tool-call', toolCallId: 'old', toolName: 'Read', input: { path: '/sandbox/old' } }
            ]
        },
        {
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'old',
                    toolName: 'Read',
                    output: { type: 'text', value: 'old output' }
                }
            ]
        },
        {
            role: 'assistant',
            content: [
                { type: 'reasoning', text: 'recent reasoning' },
                { type: 'tool-call', toolCallId: 'recent', toolName: 'Read', input: { path: '/sandbox/recent' } }
            ]
        },
        {
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'recent',
                    toolName: 'Read',
                    output: { type: 'text', value: 'recent output' }
                }
            ]
        }
    ];
}

beforeEach(() => {
    settings.autoCompactEnabled = true;
    settings.autoCompactThreshold = 80;
});

describe('in-turn compaction with real SDK pruneMessages', () => {
    it('honors the switch and leaves small or exactly-at-threshold inputs alone', () => {
        const compact = createStepCompactor(model);
        settings.autoCompactEnabled = false;
        expect(compact({ messages: toolHistory(), steps: [{ usage: { totalTokens: 1_000_000 } }] })).toBeUndefined();
        settings.autoCompactEnabled = true;
        expect(compact({ messages: toolHistory(), steps: [] })).toBeUndefined();
        expect(compact({ messages: toolHistory(), steps: [{ usage: { totalTokens: 63_200 } }] })).toBeUndefined();
    });

    it.each([
        { totalTokens: 100_000 },
        { inputTokens: 100_000 },
        { outputTokens: 100_000 },
        { inputTokens: 60_000, outputTokens: 40_000 }
    ])('uses authoritative last-step usage %j to remove old tools and all reasoning without mutation', (usage) => {
        const messages = toolHistory();
        const snapshot = structuredClone(messages);
        const result = createStepCompactor(model)({ messages, steps: [{ usage: { totalTokens: 1 } }, { usage }] });
        expect(result?.messages).toEqual([
            messages[0],
            {
                ...messages[3],
                content: [
                    { type: 'tool-call', toolCallId: 'recent', toolName: 'Read', input: { path: '/sandbox/recent' } }
                ]
            },
            messages[4]
        ]);
        expect(messages).toEqual(snapshot);
    });

    it('does not accumulate usage across steps or use an earlier huge step', () => {
        const compact = createStepCompactor(model);
        expect(
            compact({ messages: toolHistory(), steps: [{ usage: { totalTokens: 1_000_000 } }, { usage: {} }] })
        ).toBeUndefined();
        expect(
            compact({
                messages: toolHistory(),
                steps: [{ usage: { totalTokens: 1_000_000 } }, { usage: { totalTokens: 1 } }]
            })
        ).toBeUndefined();
        expect(
            compact({ messages: toolHistory(), steps: [{ usage: { totalTokens: 0, inputTokens: 1_000_000 } }] })
        ).toBeUndefined();
    });

    it('can trigger from character estimation and returns undefined if pruning would not remove a message', () => {
        const messages = toolHistory();
        messages.unshift({ role: 'system', content: '字'.repeat(70_000) });
        expect(createStepCompactor(model)({ messages, steps: [] })?.messages).toHaveLength(4);
        expect(
            createStepCompactor(model)({ messages: [{ role: 'user', content: '字'.repeat(70_000) }], steps: [] })
        ).toBeUndefined();
    });

    it('falls back rather than crashing when incoming message shape makes the SDK prune fail', () => {
        const malformed = [{ role: 'assistant', content: null }] as unknown as ModelMessage[];
        expect(
            createStepCompactor(model)({ messages: malformed, steps: [{ usage: { totalTokens: 100_000 } }] })
        ).toBeUndefined();
    });
});
