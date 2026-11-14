import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import { buildInstructionParts, joinInstructionParts, SECTION_ORDER } from '@/agent/context/builder';
import {
    appendInstructions,
    createLoopGuard,
    normalizeErrorText,
    repetitionOf,
    stableStringify,
    type StepLike
} from '@/agent/loop/guard';
import { composePrepareStep } from '@/agent/loop/prepare-step';
import { markLastMessageForCache, toInstructions, usesExplicitPromptCache } from '@/agent/model/provider';

const err = (toolName: string, error: unknown, input: unknown = {}): StepLike => ({
    content: [{ type: 'tool-error', toolName, input, error }]
});
const ok = (toolName: string, input: unknown, output: unknown): StepLike => ({
    content: [{ type: 'tool-result', toolName, input, output }]
});
const text: StepLike = { content: [{ type: 'text' }] };

describe('loop guard', () => {
    it('normalises volatile error details and serialises deterministically', () => {
        expect(normalizeErrorText('ENOENT /Users/a/b.ts line 12 id 123e4567-e89b-12d3-a456-426614174000')).toBe(
            'ENOENT <path> line <n> id <id>'
        );
        expect(normalizeErrorText('C:\\work\\x.ts failed')).toBe('<path> failed');
        expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
        expect(stableStringify(undefined)).toBe('undefined');
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(stableStringify(cyclic)).toBe('[object Object]');
    });

    it('detects consecutive identical errors (including structured { error } outputs) and identical calls', () => {
        expect(repetitionOf([])).toEqual({ count: 0 });
        expect(repetitionOf([text, { content: undefined } as unknown as StepLike])).toEqual({ count: 0 });
        expect(repetitionOf([err('Grep', 'timeout after 10ms'), err('Grep', new Error('timeout after 25ms'))])).toEqual(
            {
                kind: 'repeated-error',
                count: 2,
                toolName: 'Grep'
            }
        );
        // 不同工具打断连续计数
        expect(repetitionOf([err('Grep', 'x'), err('Read', 'x')]).count).toBe(1);
        expect(repetitionOf([ok('Task', {}, { error: 'failed 1' }), ok('Task', {}, { error: 'failed 2' })]).kind).toBe(
            'repeated-error'
        );
        expect(repetitionOf([err('MCP', { code: 1 }), err('MCP', { code: 2 })]).kind).toBe('repeated-error');
        const read = ok('Read', { path: 'a' }, 'same');
        expect(repetitionOf([read, read, read])).toEqual({ kind: 'repeated-call', count: 3, toolName: 'Read' });
        expect(repetitionOf([read, ok('Read', { path: 'b' }, 'same')]).count).toBe(1);
        expect(repetitionOf([ok('Read', { path: 'a' }, ['x'])]).kind).toBe('repeated-call');
    });

    it('detects repeated WebFetch business failures across different inputs and volatile messages', async () => {
        const guard = createLoopGuard({ maxSteps: 40, repeatLimit: 3 });
        const steps = [10, 25, 40].map((elapsed) =>
            ok(
                'WebFetch',
                { url: `https://example.com/${elapsed}` },
                { ok: false, code: 'FETCH_FAILED', message: `timeout after ${elapsed}ms` }
            )
        );
        expect(repetitionOf(steps)).toEqual({ kind: 'repeated-error', count: 3, toolName: 'WebFetch' });
        expect(await guard.stopWhen[0]({ steps: steps.slice(0, 2) as never })).toBe(false);
        expect(String(guard.prepareStep({ steps: steps.slice(0, 2) })?.instructions)).toContain(
            'WebFetch 已连续失败 2 次'
        );
        expect(await guard.stopWhen[0]({ steps: steps as never })).toBe(true);
        expect(guard.state).toMatchObject({ stopReason: 'repeated-error', toolName: 'WebFetch' });
    });

    it.each([
        { code: 'ACCESS_DENIED', message: 'request failed' },
        { code: 'FETCH_FAILED', message: 'host unreachable' }
    ])('distinguishes business errors by both code and message: %j', (different) => {
        expect(
            repetitionOf([
                ok(
                    'WebFetch',
                    { url: 'https://example.com/a' },
                    {
                        ok: false,
                        code: 'FETCH_FAILED',
                        message: 'request failed'
                    }
                ),
                ok('WebFetch', { url: 'https://example.com/b' }, { ok: false, ...different })
            ])
        ).toEqual({ kind: 'repeated-error', count: 1, toolName: 'WebFetch' });
    });

    it('resets the business error streak after a successful result', () => {
        const failure = ok('WebFetch', {}, { ok: false, code: 'FETCH_FAILED', message: 'request failed' });
        const success = ok('WebFetch', {}, { ok: true, content: 'page content' });
        expect(repetitionOf([failure, failure, success])).toEqual({
            kind: 'repeated-call',
            count: 1,
            toolName: 'WebFetch'
        });
        expect(repetitionOf([failure, failure, success, failure])).toEqual({
            kind: 'repeated-error',
            count: 1,
            toolName: 'WebFetch'
        });
    });

    it.each([
        { ok: true, code: 'FETCH_FAILED', message: 'request failed' },
        { code: 'FETCH_FAILED', message: 'request failed' },
        { ok: 'false', code: 'FETCH_FAILED', message: 'request failed' },
        { ok: false, message: 'request failed' },
        { ok: false, code: 'FETCH_FAILED' },
        { ok: false, code: 500, message: 'request failed' },
        { ok: false, code: null, message: 'request failed' },
        { ok: false, code: {}, message: 'request failed' },
        { ok: false, code: 'FETCH_FAILED', message: 500 },
        { ok: false, code: 'FETCH_FAILED', message: null },
        { ok: false, code: 'FETCH_FAILED', message: {} },
        { ok: false, code: '', message: 'request failed' },
        { ok: false, code: ' \t\n', message: 'request failed' },
        { ok: false, code: 'FETCH_FAILED', message: '' },
        { ok: false, code: 'FETCH_FAILED', message: ' \t\n' },
        [{ ok: false, code: 'FETCH_FAILED', message: 'request failed' }],
        Object.assign([], { ok: false, code: 'FETCH_FAILED', message: 'request failed' })
    ])('does not classify invalid business error shapes as failures: %j', (output) => {
        expect(
            repetitionOf([
                ok('WebFetch', { url: 'https://example.com/a' }, output),
                ok('WebFetch', { url: 'https://example.com/b' }, output)
            ])
        ).toEqual({ kind: 'repeated-call', count: 1, toolName: 'WebFetch' });
    });

    it('preserves structured string error detection and its precedence over business error fields', () => {
        expect(
            repetitionOf([
                ok('Task', {}, { error: 'legacy failure' }),
                ok('Task', {}, { error: 'legacy failure', ok: false, code: 'FETCH_FAILED', message: 'request failed' })
            ])
        ).toEqual({ kind: 'repeated-error', count: 2, toolName: 'Task' });
    });

    it('stops at max steps or the repeat limit and records the reason', async () => {
        const guard = createLoopGuard({ maxSteps: 3, repeatLimit: 3 });
        const [repeated, max] = guard.stopWhen;
        const steps = (list: StepLike[]) => ({ steps: list as never });
        expect(await max(steps([text, text]))).toBe(false);
        expect(guard.state.steps).toBe(2);
        expect(await max(steps([text, text, text]))).toBe(true);
        expect(guard.state.stopReason).toBe('max-steps');

        const g2 = createLoopGuard({ maxSteps: 40, repeatLimit: 1 });
        // 下限 2：单次失败不熔断
        expect(await g2.stopWhen[0](steps([err('Bash', 'x')]))).toBe(false);
        expect(await g2.stopWhen[0](steps([err('Bash', 'x'), err('Bash', 'x')]))).toBe(true);
        expect(g2.state).toMatchObject({ stopReason: 'repeated-error', toolName: 'Bash' });
        expect(await repeated(steps([text]))).toBe(false);
    });

    it('injects a one-off correction hint just before the limit', () => {
        const guard = createLoopGuard({ maxSteps: 40, repeatLimit: 3 });
        expect(guard.prepareStep({ steps: [err('Grep', 'x')], instructions: 'base' })).toBeUndefined();
        const hinted = guard.prepareStep({ steps: [err('Grep', 'x'), err('Grep', 'x')], instructions: 'base' });
        expect(hinted?.instructions).toMatch(/^base\n\n## 运行提示/);
        expect(String(hinted?.instructions)).toContain('Grep 已连续失败 2 次');
        const call = ok('Read', { p: 1 }, 'x');
        expect(String(guard.prepareStep({ steps: [call, call] })?.instructions)).toContain('相同参数连续调用 2 次');
        expect(guard.prepareStep({ steps: [err('Grep', 'x'), err('Grep', 'x'), err('Grep', 'x')] })).toBeUndefined();
    });

    it('appends hints to every instruction shape without mutating input', () => {
        expect(appendInstructions(undefined, 'h')).toBe('h');
        const msg = { role: 'system' as const, content: 'base' };
        expect(appendInstructions(msg, 'h')).toEqual([msg, { role: 'system', content: 'h' }]);
        const list = [msg];
        expect(appendInstructions(list, 'h')).toHaveLength(2);
        expect(list).toHaveLength(1);
    });
});

describe('composePrepareStep', () => {
    it('chains messages/instructions through parts, merges results and skips undefined', async () => {
        const m1: ModelMessage[] = [{ role: 'user', content: 'a' }];
        const m2: ModelMessage[] = [{ role: 'user', content: 'b' }];
        const seen: unknown[] = [];
        const compose = composePrepareStep(
            () => ({ messages: m1 }),
            undefined,
            async (input) => {
                seen.push(input.messages);
                return { instructions: 'x', toolChoice: 'auto' };
            },
            (input) => {
                seen.push(input.instructions);
                return undefined;
            }
        );
        expect(await compose({ messages: m2, steps: [] })).toEqual({
            messages: m1,
            instructions: 'x',
            toolChoice: 'auto'
        });
        expect(seen).toEqual([m1, 'x']);
        expect(await composePrepareStep(() => undefined)({ messages: m2, steps: [] })).toBeUndefined();
    });
});

describe('prompt caching', () => {
    it('splits instructions at the project section and joins them identically when not caching', async () => {
        const sections = [
            { id: 'project', order: SECTION_ORDER.project, build: async () => 'project' },
            { id: 'memory', order: SECTION_ORDER.memory, build: async () => 'memory' },
            { id: 'persona', order: SECTION_ORDER.persona, build: async () => 'persona' },
            { id: 'tasks', order: SECTION_ORDER.tasks, build: async () => '' }
        ];
        const parts = await buildInstructionParts('base', sections, {});
        expect(parts).toEqual({ stable: 'base\n\npersona\n\nproject', volatile: 'memory' });
        expect(joinInstructionParts(parts)).toBe('base\n\npersona\n\nproject\n\nmemory');
        expect(joinInstructionParts({ stable: '', volatile: '' })).toBe('');
        expect(toInstructions(parts, 'openai', true)).toBe('base\n\npersona\n\nproject\n\nmemory');
        expect(toInstructions(parts, 'anthropic', false)).toBe('base\n\npersona\n\nproject\n\nmemory');
    });

    it('marks the stable system prefix and the latest message for Anthropic only', () => {
        expect(usesExplicitPromptCache('anthropic', true)).toBe(true);
        expect(usesExplicitPromptCache('anthropic', false)).toBe(false);
        expect(usesExplicitPromptCache('openai-compatible', true)).toBe(false);
        expect(toInstructions({ stable: 's', volatile: 'v' }, 'anthropic', true)).toEqual([
            { role: 'system', content: 's', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
            { role: 'system', content: 'v' }
        ]);
        expect(toInstructions({ stable: 's', volatile: '' }, 'anthropic', true)).toHaveLength(1);

        const messages: ModelMessage[] = [
            { role: 'user', content: 'a' },
            { role: 'user', content: 'b', providerOptions: { anthropic: { foo: 1 }, other: { x: 1 } } }
        ];
        const marked = markLastMessageForCache({ messages });
        expect(marked?.messages[1].providerOptions).toEqual({
            anthropic: { foo: 1, cacheControl: { type: 'ephemeral' } },
            other: { x: 1 }
        });
        expect(messages[1].providerOptions).toEqual({ anthropic: { foo: 1 }, other: { x: 1 } });
        expect(marked?.messages[0]).toBe(messages[0]);
        expect(markLastMessageForCache({ messages: [] })).toBeUndefined();
        expect(markLastMessageForCache({ messages: [{ role: 'system', content: 's' }] })).toBeUndefined();
    });
});
