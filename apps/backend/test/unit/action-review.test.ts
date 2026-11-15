import type * as AiSdk from 'ai';
import { generateText } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createActionReview } from '@/agent/tools/action-review';
import { createApprovalPipeline } from '@/agent/tools/approval-pipeline';

vi.mock('ai', async (importOriginal) => ({
    ...(await importOriginal<typeof AiSdk>()),
    generateText: vi.fn()
}));

const request = '使用ego帮我搜一下百度最近的新闻';
const cwd = '/tmp/zhuixun-workspace';
const toolCall = {
    toolName: 'Bash',
    input: {
        command: [
            "ego-browser nodejs <<'EOF'",
            'const task = await taskSpace("百度新闻");',
            'const page = task.page("p1");',
            'await page.goto("https://www.baidu.com/s?wd=百度&result_type=news");',
            'console.log(await page.snapshot());',
            'EOF'
        ].join('\n')
    }
};

const generate = vi.mocked(generateText);
const reviewAction = createActionReview({ model: 'test/reviewer', request, cwd });

function pipeline(options: Partial<Parameters<typeof createApprovalPipeline>[0]> = {}) {
    return createApprovalPipeline({
        mode: 'auto-review',
        danger: false,
        hasUi: true,
        fallback: () => 'user-approval',
        reviewAction,
        ...options
    });
}

beforeEach(() => generate.mockReset());

describe('automatic action review', () => {
    it('reviews the complete ego script against the current user request and records the result', async () => {
        generate.mockResolvedValue({ output: { decision: 'approve' } } as Awaited<ReturnType<typeof generateText>>);
        const onDecision = vi.fn();
        const result = await pipeline({ onDecision })({ toolCall });

        expect(result).toMatchObject({ type: 'approved' });
        expect(onDecision).toHaveBeenCalledWith(toolCall, 'action-review', result);
        expect(generate).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: JSON.stringify({ request, cwd, ...toolCall }) })
        );
    });

    it('provides successful commands from the active turn when reviewing browser cleanup', async () => {
        generate.mockResolvedValue({ output: { decision: 'approve' } } as Awaited<ReturnType<typeof generateText>>);
        const cleanup = {
            toolName: 'Bash',
            input: {
                command: "ego-browser nodejs -e 'const task = await taskSpace(10); await task.finish({ keep: [] });'"
            }
        };
        const bashCall = (id: string, command: string) => ({
            type: 'tool-call' as const,
            toolName: 'Bash',
            toolCallId: id,
            input: { command }
        });
        const bashResult = (id: string, exitCode: number) => ({
            type: 'tool-result' as const,
            toolName: 'Bash',
            toolCallId: id,
            output: { type: 'json' as const, value: { exitCode, stdout: '网页正文' } }
        });

        const result = await pipeline()({
            toolCall: cleanup,
            messages: [
                { role: 'assistant', content: [bashCall('old', 'old command')] },
                { role: 'tool', content: [bashResult('old', 0)] },
                { role: 'user', content: request },
                {
                    role: 'assistant',
                    content: [bashCall('search', toolCall.input.command), bashCall('failed', 'failed command')]
                },
                { role: 'tool', content: [bashResult('search', 0), bashResult('failed', 1)] }
            ]
        });

        expect(result).toMatchObject({ type: 'approved' });
        expect(generate).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: JSON.stringify({ request, cwd, ...cleanup, successfulCommands: [toolCall.input.command] })
            })
        );
    });

    it.each([
        ['deny', 'denied'],
        ['ask', 'user-approval']
    ])('returns the %s verdict to the tool approval pipeline', async (decision, type) => {
        generate.mockResolvedValue({ output: { decision } } as Awaited<ReturnType<typeof generateText>>);
        expect(await pipeline()({ toolCall })).toMatchObject({ type });
    });

    it('falls back to manual approval if the reviewer fails', async () => {
        generate.mockImplementationOnce(() => {
            throw new Error('provider unavailable');
        });
        expect(await pipeline()({ toolCall })).toMatchObject({ type: 'user-approval' });
    });

    it('does not invoke the reviewer for explicit policy asks, manual mode or protected writes', async () => {
        expect(await pipeline({ policy: async () => ({ decision: 'ask' }) })({ toolCall })).toMatchObject({
            type: 'user-approval'
        });
        expect(await pipeline({ mode: 'ask' })({ toolCall })).toBe('user-approval');
        expect(await pipeline({ writeDenylisted: () => true })({ toolCall })).toBe('user-approval');
        expect(generate).not.toHaveBeenCalled();
    });
});
