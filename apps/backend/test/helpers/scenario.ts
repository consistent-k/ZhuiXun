import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { UIMessage, UIMessageChunk } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { expect } from 'vitest';

import type { ChatTurnInput } from '@/modules/chat';
import type { SkillRegistry } from '@/modules/skills';

/**
 * 行为回归场景 helper：脚本化模型（MockLanguageModelV4）+ 真实 runChatTurn。
 *
 * 测试文件需自行 `vi.mock('@/agent/model/provider', ...)` 把 createModel 指向 `scenario.model`
 * （vi.mock 只在测试文件内被提升，helper 里写不生效）。其余链路——审批管线、策略、护栏、落库、命令展开——全部真实执行；
 * 数据目录由 test/setup.ts 隔离到临时 HOME。
 */

/** 单次模型调用（一个 step）的脚本。 */
export type ScriptStep =
    { text: string } | { toolCalls: Array<{ name: string; input: unknown; id?: string }> } | { error: unknown };

const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
};

let callSeq = 0;

function partsOf(step: ScriptStep): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
    if ('error' in step) {
        parts.push({ type: 'error', error: step.error });
        return parts;
    }
    if ('text' in step) {
        parts.push(
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: step.text },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }
        );
        return parts;
    }
    for (const call of step.toolCalls) {
        parts.push({
            type: 'tool-call',
            toolCallId: call.id ?? `call-${++callSeq}`,
            toolName: call.name,
            input: JSON.stringify(call.input)
        });
    }
    parts.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
    return parts;
}

function streamOf(parts: LanguageModelV4StreamPart[]) {
    return new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        }
    });
}

/**
 * 按步返回脚本的模型；脚本耗尽后重复最后一步（便于测「同调用循环」）。
 * `prompts` 记录每次调用收到的 prompt，供断言喂给模型的内容。
 */
export function scriptedModel(steps: ScriptStep[]) {
    let index = 0;
    const model = new MockLanguageModelV4({
        // 首轮标题生成走 generateText：给固定标题，避免「未实现」告警刷屏
        doGenerate: async () => ({
            content: [{ type: 'text', text: '场景测试' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage,
            warnings: []
        }),
        doStream: async () => {
            const step = steps[Math.min(index, steps.length - 1)];
            index++;
            return { stream: streamOf(partsOf(step)) };
        }
    });
    return model;
}

/** 场景用的最小技能注册表端口（无技能、无 MCP）。 */
export function fakeRegistry(): SkillRegistry {
    const adapter = { getAllTools: async () => ({}) };
    return {
        getCatalog: () => '（无技能）',
        loadEnabled: async () => [],
        getUserSkillDirNames: () => ({ enabled: [], disabled: [] }),
        getSkillsDir: () => '/nonexistent-skills',
        getMCPAdapter: () => adapter,
        getMCPDiscovery: () => ({ searchTools: async () => [] }),
        get: async () => null,
        getMetadataById: () => undefined,
        listMetadata: () => []
    } as unknown as SkillRegistry;
}

let msgSeq = 0;

export function userMessage(text: string, extraParts: unknown[] = []): UIMessage {
    return {
        id: `scenario-user-${++msgSeq}`,
        role: 'user',
        parts: [{ type: 'text', text }, ...extraParts] as UIMessage['parts']
    };
}

export interface ScenarioResult {
    chunks: UIMessageChunk[];
    chatId: string;
    /** 结束时的 message metadata（finish chunk 上） */
    metadata?: Record<string, unknown>;
}

/** 走真实 runChatTurn 跑一轮，收集全部 UIMessageChunk。 */
export async function runScenarioTurn(input: ChatTurnInput, registry = fakeRegistry()): Promise<ScenarioResult> {
    const { runChatTurn } = await import('@/modules/chat');
    const handle = await runChatTurn(input, registry);
    const chunks: UIMessageChunk[] = [];
    for await (const chunk of handle.stream as AsyncIterable<UIMessageChunk>) chunks.push(chunk);
    const finish = chunks.find((c) => c.type === 'finish') as { messageMetadata?: Record<string, unknown> } | undefined;
    return { chunks, chatId: handle.chatId, metadata: finish?.messageMetadata };
}

/** 工具调用序列（按出现顺序的工具名）。 */
export function toolSequence(chunks: UIMessageChunk[]): string[] {
    return chunks
        .filter(
            (c): c is Extract<UIMessageChunk, { type: 'tool-input-available' }> => c.type === 'tool-input-available'
        )
        .map((c) => c.toolName);
}

export function expectToolSequence(result: ScenarioResult, expected: string[]): void {
    expect(toolSequence(result.chunks)).toEqual(expected);
}

/** 断言某个工具调用的审批结果：requested（需用户确认）/ denied（自动拒绝）/ executed（已执行出结果）。 */
export function approvalOf(
    result: ScenarioResult,
    toolName: string
): 'requested' | 'denied' | 'executed' | 'error' | 'none' {
    const call = result.chunks.find(
        (c) => c.type === 'tool-input-available' && (c as { toolName: string }).toolName === toolName
    ) as { toolCallId: string } | undefined;
    if (!call) return 'none';
    const of = (type: string) =>
        result.chunks.some((c) => c.type === type && (c as { toolCallId?: string }).toolCallId === call.toolCallId);
    // 自动放行 / 自动拒绝也会产生 isAutomatic 的 approval-request，故先看最终结果
    if (of('tool-output-denied')) return 'denied';
    if (of('tool-output-available')) return 'executed';
    if (of('tool-output-error')) return 'error';
    if (of('tool-approval-request')) return 'requested';
    return 'none';
}

export function expectStopReason(result: ScenarioResult, reason: string | undefined): void {
    expect(result.metadata?.stopReason).toBe(reason);
}
