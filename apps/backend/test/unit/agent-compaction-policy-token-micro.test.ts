import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import { CLEARED_TOOL_OUTPUT, microcompactMessages } from '@/agent/compaction/microcompact';
import { isContextOverflowError } from '@/agent/compaction/overflow-error';
import { resolveCompactionPolicy } from '@/agent/compaction/policy';
import { estimateMessageTokens, estimateMessagesTokens, estimateTokens } from '@/agent/compaction/token-estimate';
import type { ResolvedModel } from '@/config/types';

const model: ResolvedModel = {
    kind: 'openai-compatible',
    baseURL: 'https://unused.invalid',
    apiKey: '',
    modelName: 'fake'
};

function message(parts: unknown, id = 'm'): UIMessage {
    return { id, role: 'assistant', parts } as UIMessage;
}

function tool(output: unknown = 'x'.repeat(4000), extra: Record<string, unknown> = {}) {
    return { type: 'tool-Read', state: 'output-available', input: { path: '/sandbox/a' }, output, ...extra };
}

describe('compaction policy', () => {
    it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('defaults invalid window %s', (contextWindow) => {
        expect(resolveCompactionPolicy({ ...model, contextWindow }, 80)).toEqual({
            contextWindow: 200_000,
            outputReserveTokens: 21_000,
            effectiveContextWindow: 179_000,
            compactThreshold: 143_200,
            microcompactThreshold: 128_880
        });
    });

    it('rounds windows down, clamps percentages, and caps thresholds with the safety buffer', () => {
        expect(resolveCompactionPolicy({ ...model, contextWindow: 100_000.9 }, 150)).toEqual({
            contextWindow: 100_000,
            outputReserveTokens: 21_000,
            effectiveContextWindow: 79_000,
            compactThreshold: 66_000,
            microcompactThreshold: 59_400
        });
        expect(resolveCompactionPolicy(model, -100).compactThreshold).toBe(1790);
        expect(resolveCompactionPolicy(model, 50.6).compactThreshold).toBe(91_290);
        expect(resolveCompactionPolicy({ ...model, contextWindow: 30_000 }, 80).compactThreshold).toBe(0);
        expect(resolveCompactionPolicy({ ...model, contextWindow: 10_000 }, 80)).toMatchObject({
            outputReserveTokens: 10_000,
            effectiveContextWindow: 0,
            compactThreshold: 0,
            microcompactThreshold: 0
        });
        expect(resolveCompactionPolicy({ ...model, contextWindow: 36_000 }, 80).microcompactThreshold).toBe(0);
    });
});

describe('token estimation', () => {
    it.each([
        ['', 0],
        ['abcd', 1],
        ['abcde', 2],
        ['中文あカ', 4],
        ['中文abcd', 3]
    ])('estimates %j as %s tokens', (text, expected) => {
        expect(estimateTokens(text)).toBe(expected);
    });

    it('handles both UI and model messages and ignores unknown parts', () => {
        expect(estimateMessageTokens({})).toBe(4);
        expect(estimateMessageTokens({ content: 'abcd' })).toBe(5);
        expect(estimateMessageTokens({ parts: [], content: 'ignored' })).toBe(4);
        expect(estimateMessageTokens({ content: 123 })).toBe(4);
        expect(estimateMessagesTokens([])).toBe(0);
        expect(estimateMessagesTokens([{ parts: [{ type: 'text', text: '中文' }] }, { content: 'abcd' }])).toBe(11);
        expect(estimateMessageTokens({ parts: [null, 1, false, { type: 'unknown' }, {}, { type: 'text' }] })).toBe(4);
        expect(estimateMessageTokens({ parts: [{ type: 'reasoning', text: 'abcd' }] })).toBe(5);
        expect(
            estimateMessageTokens({ parts: [{ type: 'file' }, { type: 'image' }, { type: 'reasoning-file' }] })
        ).toBe(3604);
    });

    it('counts tool payloads and safely handles circular and non-serializable inputs', () => {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        expect(estimateMessageTokens({ parts: [{ type: 'tool-call', input: circular, output: 1n }] })).toBe(204);
        expect(estimateMessageTokens({ parts: [{ type: 'tool-result', input: null, output: undefined }] })).toBe(204);
        expect(estimateMessageTokens({ parts: [{ type: 'tool-Read', input: () => 1, output: 'abcd' }] })).toBe(206);
        expect(estimateMessageTokens({ parts: [{ type: 'tool-call', input: { a: 1 }, output: '中' }] })).toBe(208);
    });
});

describe('deterministic microcompaction', () => {
    it('leaves empty, small, insufficient groups, and low savings inputs untouched', () => {
        const empty: UIMessage[] = [];
        expect(microcompactMessages(empty, { thresholdTokens: 0 }).messages).toBe(empty);
        const messages = [message([tool()], 'old'), message([tool()], 'recent')];
        expect(microcompactMessages(messages, { thresholdTokens: 100_000 }).messages).toBe(messages);
        expect(microcompactMessages(messages, { thresholdTokens: 0 }).messages).toBe(messages);
        expect(
            microcompactMessages(messages, { thresholdTokens: 0, keepRecentGroups: 1, minSavingsTokens: 100_000 })
        ).toEqual({
            messages,
            clearedCount: 0,
            savedTokens: 0
        });
        const tiny = [message([tool('a')]), message([tool('b')])];
        expect(microcompactMessages(tiny, { thresholdTokens: 0, keepRecentGroups: 1 }).messages).toBe(tiny);
    });

    it('clears whole old parallel groups without mutation and keeps the newest five groups by default', () => {
        const messages = Array.from({ length: 7 }, (_, i) =>
            message([tool(), tool(undefined, { type: 'tool-Bash' })], `m${i}`)
        );
        const snapshot = structuredClone(messages);
        const result = microcompactMessages(messages, { thresholdTokens: 0 });
        expect(result.clearedCount).toBe(4);
        expect(result.savedTokens).toBe(estimateMessagesTokens(messages) - estimateMessagesTokens(result.messages));
        expect(result.savedTokens).toBeGreaterThan(256);
        expect(result.messages[0].parts).toEqual(messages[0].parts.map((p) => ({ ...p, output: CLEARED_TOOL_OUTPUT })));
        expect(result.messages[2]).toBe(messages[2]);
        expect(messages).toEqual(snapshot);
        expect(microcompactMessages(result.messages, { thresholdTokens: 0 }).messages).toBe(result.messages);
    });

    it('supports MCP and dynamic tools, clamps retention to at least one, and preserves safety-sensitive parts', () => {
        const protectedParts = [
            null,
            1,
            { type: 'text', text: 'context' },
            tool('failure', { state: 'output-error' }),
            tool('denied', { state: 'output-denied' }),
            tool(undefined, { output: undefined }),
            tool(CLEARED_TOOL_OUTPUT),
            tool({ type: 'image', data: 'data' }),
            tool([{ type: 'file' }]),
            tool([{ type: 'video' }]),
            tool('custom', { type: 'tool-private' }),
            { output: 'no tool name' },
            { type: 'dynamic-tool', output: 'no tool name' }
        ];
        const clearable = [
            tool(['plain', null, 1]),
            tool({ type: 1 }),
            tool({ value: 'plain' }),
            tool('mcp'.repeat(2000), { type: 'tool-mcp__files__read' }),
            tool('dynamic'.repeat(2000), { type: 'dynamic-tool', toolName: 'Read' })
        ];
        const messages = [message([...protectedParts, ...clearable]), message(undefined), message([tool()])];
        const result = microcompactMessages(messages, { thresholdTokens: 0, keepRecentGroups: 0 });
        expect(result.clearedCount).toBe(clearable.length);
        expect(result.messages[0].parts.slice(0, protectedParts.length)).toEqual(protectedParts);
        expect(result.messages[0].parts.slice(protectedParts.length)).toEqual(
            clearable.map((p) => ({ ...p, output: CLEARED_TOOL_OUTPUT }))
        );
        expect(result.messages[1]).toBe(messages[1]);
        expect(result.messages[2]).toBe(messages[2]);
    });
});

describe('provider overflow recognition', () => {
    it.each([
        'context_length_exceeded',
        'CONTEXT-WINDOW full',
        'maximum context reached',
        'too many tokens',
        'token limit reached',
        'prompt is too long',
        'input is too long',
        'reduce the length',
        'reduce size',
        'exceeded maximum token count',
        '超出了上下文',
        '上下文过长'
    ])('recognizes %s', (text) => {
        expect(isContextOverflowError(text)).toBe(true);
    });

    it('reads SDK nested errors but never treats auth, rate limits or arbitrary objects as overflow', () => {
        expect(isContextOverflowError(new Error('context length exceeded'))).toBe(true);
        expect(isContextOverflowError({ responseBody: 'context window exceeded' })).toBe(true);
        expect(isContextOverflowError({ data: 'too many tokens' })).toBe(true);
        expect(isContextOverflowError({ cause: new Error('input is too long') })).toBe(true);
        for (const value of [
            undefined,
            null,
            '',
            1,
            false,
            {},
            { responseBody: {}, data: 1 },
            new Error('429 rate limited'),
            '401 unauthorized',
            'network down'
        ]) {
            expect(isContextOverflowError(value)).toBe(false);
        }
    });
});
