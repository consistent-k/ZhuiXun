import { describe, expect, it, vi } from 'vitest';

import { createApprovalPipeline, type ApprovalPipelineOptions } from '@/agent/tools/approval-pipeline';
import { mergeHookContext, wrapToolsWithHooks, type ToolHookRunner } from '@/agent/tools/hook-wrapper';

function pipeline(overrides: Partial<ApprovalPipelineOptions> = {}) {
    const fallback = vi.fn(async (toolName: string) => (toolName === 'Bash' ? 'user-approval' : 'not-applicable'));
    const fn = createApprovalPipeline({ hasUi: true, danger: false, fallback, ...overrides });
    const call = (toolName: string, input: unknown = {}) => fn({ toolCall: { toolName, input } });
    return { call, fallback };
}

const hooks = (pre: ToolHookRunner['pre'], match = true): Pick<ToolHookRunner, 'matches' | 'pre'> => ({
    matches: () => match,
    pre
});

describe('approval pipeline', () => {
    it('falls back to the broker when policy and hooks are silent', async () => {
        const { call, fallback } = pipeline({ policy: async () => ({ decision: 'none' }) });
        expect(await call('Bash', { command: 'x' })).toBe('user-approval');
        expect(await call('Read')).toBe('not-applicable');
        expect(fallback).toHaveBeenCalledWith('Bash', { command: 'x' });
        expect(await pipeline().call('Read')).toBe('not-applicable');
    });

    it('denies on policy deny even in danger mode, before running hooks', async () => {
        const pre = vi.fn();
        const { call } = pipeline({
            danger: true,
            policy: async () => ({ decision: 'deny', reason: 'rule' }),
            hooks: hooks(pre)
        });
        expect(await call('Read')).toEqual({ type: 'denied', reason: 'rule' });
        expect(pre).not.toHaveBeenCalled();
    });

    it('maps ask to user-approval (UI), approved (danger) and denied (no UI)', async () => {
        const policy = async () => ({ decision: 'ask' as const, reason: 'confirm' });
        expect(await pipeline({ policy }).call('Bash')).toEqual({ type: 'user-approval', reason: 'confirm' });
        expect(await pipeline({ policy, danger: true }).call('Bash')).toEqual({ type: 'approved', reason: 'confirm' });
        expect(await pipeline({ policy, hasUi: false }).call('Bash')).toMatchObject({
            type: 'denied',
            reason: expect.stringContaining('自动拒绝')
        });
        expect(await pipeline({ policy: async () => ({ decision: 'ask' }) }).call('x')).toMatchObject({
            type: 'user-approval'
        });
    });

    it('applies PreToolUse deny / ask / failure / allow in order', async () => {
        expect(
            await pipeline({ hooks: hooks(async () => ({ decision: 'deny', reason: 'lint' })) }).call('Edit')
        ).toEqual({
            type: 'denied',
            reason: 'PreToolUse hook 拒绝：lint'
        });
        expect(await pipeline({ hooks: hooks(async () => ({ decision: 'deny' })) }).call('Edit')).toEqual({
            type: 'denied',
            reason: 'PreToolUse hook 拒绝'
        });
        expect(await pipeline({ hooks: hooks(async () => ({ decision: 'ask', reason: 'r' })) }).call('Edit')).toEqual({
            type: 'user-approval',
            reason: 'PreToolUse hook 要求确认：r'
        });
        expect(await pipeline({ hooks: hooks(async () => ({ decision: 'ask' })) }).call('Edit')).toMatchObject({
            type: 'user-approval'
        });
        expect(
            await pipeline({ hooks: hooks(async () => ({ decision: 'ask', failed: true, reason: 'timeout' })) }).call(
                'Edit'
            )
        ).toEqual({ type: 'user-approval', reason: 'timeout，需要确认' });
        expect(await pipeline({ hooks: hooks(() => Promise.reject(new Error('spawn'))) }).call('Edit')).toMatchObject({
            type: 'user-approval',
            reason: expect.stringContaining('spawn')
        });
        expect(await pipeline({ hooks: hooks(() => Promise.reject('raw')) }).call('Edit')).toMatchObject({
            reason: expect.stringContaining('raw')
        });
        expect(await pipeline({ hooks: hooks(async () => ({ decision: 'allow' })) }).call('Bash')).toEqual({
            type: 'approved',
            reason: 'PreToolUse hook 放行'
        });
        // 未匹配的 hook 不执行
        const pre = vi.fn();
        expect(await pipeline({ hooks: hooks(pre, false) }).call('Bash')).toBe('user-approval');
        expect(pre).not.toHaveBeenCalled();
    });

    it('policy ask outranks hook allow; allow never bypasses the system-dir write guard', async () => {
        expect(
            await pipeline({
                policy: async () => ({ decision: 'ask', reason: 'a' }),
                hooks: hooks(async () => ({ decision: 'allow' }))
            }).call('Bash')
        ).toMatchObject({ type: 'user-approval' });
        const writeDenylisted = vi.fn(() => true);
        expect(
            await pipeline({ policy: async () => ({ decision: 'allow', reason: 'ok' }), writeDenylisted }).call(
                'Write',
                {
                    path: '/etc/x'
                }
            )
        ).toEqual({ type: 'user-approval', reason: '写入目标位于系统目录，需要确认' });
        expect(writeDenylisted).toHaveBeenCalledWith('Write', { path: '/etc/x' });
        expect(await pipeline({ policy: async () => ({ decision: 'allow', reason: 'ok' }) }).call('Write')).toEqual({
            type: 'approved',
            reason: 'ok'
        });
    });

    it('exempts interaction tools and turns broker user-approval into denied without UI', async () => {
        const policy = vi.fn(async () => ({ decision: 'deny' as const }));
        const { call } = pipeline({ policy, exempt: new Set(['askUserQuestion']) });
        expect(await call('askUserQuestion')).toBe('not-applicable');
        expect(policy).not.toHaveBeenCalled();
        const noUi = pipeline({ hasUi: false });
        expect(await noUi.call('Bash')).toMatchObject({ type: 'denied' });
        expect(await noUi.call('Read')).toBe('not-applicable');
        const objectStatus = pipeline({ hasUi: false, fallback: async () => ({ type: 'user-approval', reason: 'x' }) });
        expect(await objectStatus.call('Bash')).toMatchObject({ type: 'denied' });
        expect(await pipeline({ hasUi: false, fallback: async () => undefined }).call('Bash')).toBeUndefined();
    });

    it('reviews only eligibility returned by the broker, after policy and hooks', async () => {
        const review = vi.fn(async ({ toolName }) => toolName === 'Edit');
        const fallback = async () => 'user-approval' as const;
        expect(await pipeline({ mode: 'auto-review', review, fallback }).call('Edit')).toMatchObject({
            type: 'approved'
        });
        expect(await pipeline({ mode: 'auto-review', review, fallback }).call('Bash')).toBe('user-approval');
        review.mockClear();
        const policy = async () => ({ decision: 'ask' as const });
        expect(await pipeline({ mode: 'auto-review', review, fallback, policy }).call('Edit')).toMatchObject({
            type: 'user-approval'
        });
        expect(review).not.toHaveBeenCalled();
    });

    it('full access skips ordinary approvals while preserving denies and protected asks', async () => {
        const mode = 'full-access' as const;
        expect(await pipeline({ mode }).call('Bash')).toMatchObject({ type: 'approved' });
        expect(await pipeline({ mode, policy: async () => ({ decision: 'ask' }) }).call('Bash')).toMatchObject({
            type: 'approved'
        });
        expect(await pipeline({ mode, policy: async () => ({ decision: 'deny' }) }).call('Bash')).toMatchObject({
            type: 'denied'
        });
        expect(
            await pipeline({ mode, policy: async () => ({ decision: 'ask', requiresHuman: true }) }).call('Bash')
        ).toMatchObject({ type: 'user-approval' });
        expect(
            await pipeline({ mode, hooks: hooks(async () => ({ decision: 'ask', failed: true })) }).call('Bash')
        ).toMatchObject({ type: 'user-approval' });
        expect(await pipeline({ mode, writeDenylisted: () => true }).call('Write')).toMatchObject({
            type: 'user-approval'
        });
        expect(await pipeline({ mode, hasUi: false }).call('Bash')).toMatchObject({ type: 'denied' });
    });

    it('never fails open when a port throws', async () => {
        const boom = async () => {
            throw new Error('boom');
        };
        expect(await pipeline({ policy: boom }).call('Bash')).toMatchObject({ type: 'user-approval' });
        expect(await pipeline({ policy: boom, hasUi: false }).call('Bash')).toMatchObject({ type: 'denied' });
        expect(await pipeline({ policy: () => Promise.reject('s'), danger: true }).call('Bash')).toMatchObject({
            type: 'denied'
        });
    });
});

describe('hook wrapper', () => {
    it('merges hook context into object, string and other outputs', () => {
        expect(mergeHookContext({ a: 1 }, {})).toEqual({ a: 1 });
        expect(mergeHookContext({ a: 1 }, { additionalContext: 'fmt' })).toEqual({ a: 1, _hookContext: 'fmt' });
        expect(mergeHookContext('out', { blocked: true, reason: 'lint' })).toBe('out\n\n[hook]\n后置检查未通过：lint');
        expect(mergeHookContext([1], { blocked: true })).toEqual({
            result: [1],
            _hookContext: '后置检查未通过：（hook 未给出原因）'
        });
    });

    it('wraps only matching tools with execute and leaves originals untouched', async () => {
        const execute = vi.fn(async () => ({ ok: true }));
        const stream = vi.fn(async () => ({ [Symbol.asyncIterator]: async function* () {} }));
        const tools = {
            Edit: { description: 'e', inputSchema: {}, execute },
            Stream: { description: 's', inputSchema: {}, execute: stream },
            Client: { description: 'c', inputSchema: {} },
            Read: { description: 'r', inputSchema: {}, execute }
        } as never;
        const post = vi.fn(async () => ({ additionalContext: 'formatted' }));
        const runner: ToolHookRunner = {
            matches: (_event, name) => name !== 'Read',
            pre: vi.fn(),
            post
        };
        expect(wrapToolsWithHooks(tools)).toBe(tools);
        const wrapped = wrapToolsWithHooks(tools, runner) as Record<string, { execute?: (...a: unknown[]) => unknown }>;
        const original = tools as Record<string, unknown>;
        expect(wrapped.Read).toBe(original.Read);
        expect(wrapped.Client).toBe(original.Client);
        expect(wrapped.Edit).not.toBe(original.Edit);
        expect(await wrapped.Edit.execute!({ file_path: 'a' }, { toolCallId: 'c1' })).toEqual({
            ok: true,
            _hookContext: 'formatted'
        });
        expect(post).toHaveBeenCalledWith(
            { toolName: 'Edit', input: { file_path: 'a' }, toolCallId: 'c1' },
            { ok: true }
        );
        const iterable = await wrapped.Stream.execute!({}, undefined);
        expect(Symbol.asyncIterator in (iterable as object)).toBe(true);
        expect(post).toHaveBeenCalledTimes(1);
    });
});
