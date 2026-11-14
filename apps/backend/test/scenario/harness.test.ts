import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { APICallError } from 'ai';
import type { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ProviderModule from '@/agent/model/provider';
import { addProvider, deleteProvider, listProviders, setActiveModel, updateAppSettings } from '@/config/settings-store';
import { WORKSPACE_DIR } from '@/config/shell';
import { getCommandStore } from '@/modules/commands';
import { getConversationStore } from '@/modules/conversations';
import { getPermissionStore } from '@/modules/permission';

import {
    approvalOf,
    expectStopReason,
    expectToolSequence,
    runScenarioTurn,
    scriptedModel,
    userMessage,
    type ScriptStep
} from '../helpers/scenario';

/**
 * Agent 行为回归（确定性场景）：脚本化模型 + 真实 runChatTurn / 审批管线 / 护栏 / 落库。
 * 只替换模型实例与危险模式旗标；shell 工具仅用 Read（真实读临时工作区），不起子进程。
 */
const scenario = vi.hoisted(() => ({ model: undefined as unknown, danger: false }));
vi.mock('@/agent/model/provider', async (original) => ({
    ...(await original<typeof ProviderModule>()),
    createModel: () => scenario.model
}));
vi.mock('@/config/danger-mode', () => ({
    isDangerouslySkipPermissions: () => scenario.danger,
    getDangerModeStatus: () => ({ enabled: scenario.danger })
}));

function useScript(steps: ScriptStep[]): MockLanguageModelV4 {
    const model = scriptedModel(steps);
    scenario.model = model;
    return model;
}

/** 某次模型调用收到的 prompt 文本（用于断言命令展开等喂给模型的内容）。 */
function promptText(model: MockLanguageModelV4, call = 0): string {
    return JSON.stringify(model.doStreamCalls[call]?.prompt ?? []);
}

beforeEach(async () => {
    scenario.danger = false;
    for (const p of listProviders()) deleteProvider(p.name);
    addProvider({
        name: 'scenario',
        kind: 'openai-compatible',
        baseURL: 'https://model.invalid/v1',
        apiKey: 'scenario-test-key',
        models: ['scripted']
    });
    setActiveModel('scenario/scripted');
    updateAppSettings({ maxAgentSteps: 10, repeatErrorLimit: 3, autoCompactEnabled: false });
    await getPermissionStore().setRules({ deny: [], ask: [], allow: [] });
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    await fs.writeFile(path.join(WORKSPACE_DIR, 'notes.md'), '病例笔记');
});

describe('scenario: permission policy', () => {
    it('denies reading secret files via the built-in baseline, and the model sees the denial', async () => {
        const model = useScript([
            { toolCalls: [{ name: 'Read', input: { path: '.env' } }] },
            { text: '无法读取密钥文件' }
        ]);
        const result = await runScenarioTurn({ messages: [userMessage('读一下 .env')], sessionId: randomUUID() });
        expectToolSequence(result, ['Read']);
        expect(approvalOf(result, 'Read')).toBe('denied');
        expect(promptText(model, 1)).toContain('Read(**/.env)');
        expectStopReason(result, undefined);
    });

    it('keeps deny rules active in danger mode while ask rules are approved', async () => {
        scenario.danger = true;
        useScript([{ toolCalls: [{ name: 'Read', input: { path: 'cert/server.pem' } }] }, { text: '好的' }]);
        const denied = await runScenarioTurn({ messages: [userMessage('读证书')], sessionId: randomUUID() });
        expect(approvalOf(denied, 'Read')).toBe('denied');

        await getPermissionStore().setRules({ deny: [], ask: ['Read(./notes.md)'], allow: [] });
        useScript([{ toolCalls: [{ name: 'Read', input: { path: 'notes.md' } }] }, { text: '读完了' }]);
        const approved = await runScenarioTurn({ messages: [userMessage('读笔记')], sessionId: randomUUID() });
        expect(approvalOf(approved, 'Read')).toBe('executed');
    });

    it('asks for confirmation when a user ask rule matches and pauses the turn', async () => {
        await getPermissionStore().setRules({ deny: [], ask: ['Read(./notes.md)'], allow: [] });
        useScript([{ toolCalls: [{ name: 'Read', input: { path: 'notes.md' } }] }]);
        const result = await runScenarioTurn({ messages: [userMessage('读笔记')], sessionId: randomUUID() });
        expect(approvalOf(result, 'Read')).toBe('requested');
        const request = result.chunks.find((c) => c.type === 'tool-approval-request') as {
            reason?: string;
            isAutomatic?: boolean;
        };
        expect(request.reason).toContain('Read(./notes.md)');
        expect(request.isAutomatic).toBeFalsy();
    });

    it('lets unmatched read-only tools run without approval', async () => {
        const model = useScript([
            { toolCalls: [{ name: 'Read', input: { path: 'notes.md' } }] },
            { text: '笔记内容是病例' }
        ]);
        const result = await runScenarioTurn({ messages: [userMessage('读笔记')], sessionId: randomUUID() });
        expect(approvalOf(result, 'Read')).toBe('executed');
        expect(promptText(model, 1)).toContain('病例笔记');
    });
});

describe('scenario: loop guard', () => {
    it('stops a repeated identical failure and records stopReason=repeated-error', async () => {
        const model = useScript([{ toolCalls: [{ name: 'Read', input: { path: 'missing.md' } }] }]);
        const result = await runScenarioTurn({ messages: [userMessage('读文件')], sessionId: randomUUID() });
        expectToolSequence(result, ['Read', 'Read', 'Read']);
        expectStopReason(result, 'repeated-error');
        expect(result.metadata?.steps).toBe(3);
        // 达到上限前一步注入了纠偏提示
        expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain('运行提示');
    });

    it('stops identical successful calls with stopReason=repeated-call', async () => {
        useScript([{ toolCalls: [{ name: 'Read', input: { path: 'notes.md' } }] }]);
        const result = await runScenarioTurn({ messages: [userMessage('读笔记')], sessionId: randomUUID() });
        expectStopReason(result, 'repeated-call');
    });

    it('stops at the configured step limit with stopReason=max-steps', async () => {
        updateAppSettings({ maxAgentSteps: 10, repeatErrorLimit: 10 });
        // LS / Read 交替调用，避免触发重复调用熔断；只验证步数上限
        const steps: ScriptStep[] = Array.from({ length: 12 }, (_, i) =>
            i % 2 === 0
                ? { toolCalls: [{ name: 'LS', input: { path: '.' } }] }
                : { toolCalls: [{ name: 'Read', input: { path: 'notes.md' } }] }
        );
        useScript(steps);
        const result = await runScenarioTurn({ messages: [userMessage('一直看')], sessionId: randomUUID() });
        expectStopReason(result, 'max-steps');
        expect(result.metadata?.steps).toBe(10);
    });
});

describe('scenario: model errors, slash commands and persistence', () => {
    it('turns an auth failure into a readable error without retrying', async () => {
        const model = useScript([
            {
                error: new APICallError({
                    message: 'unauthorized',
                    url: 'https://model.invalid',
                    requestBodyValues: {},
                    statusCode: 401
                })
            }
        ]);
        const result = await runScenarioTurn({ messages: [userMessage('你好')], sessionId: randomUUID() });
        const error = result.chunks.find((c) => c.type === 'error') as { errorText: string };
        expect(error.errorText).toContain('密钥无效');
        expect(model.doStreamCalls).toHaveLength(1);
    });

    it('keeps a turn successful when a tool call fails and the model recovers', async () => {
        const model = useScript([
            { toolCalls: [{ name: 'not_a_tool', input: { query: 'x' }, id: 'call-missing' }] },
            { text: '已改用其他方式回答' }
        ]);
        const sessionId = randomUUID();
        const result = await runScenarioTurn({ messages: [userMessage('查一下')], sessionId });
        // 未知工具在执行前失败，SDK 以 tool-input-error 交回模型。
        expect(result.chunks).toContainEqual(
            expect.objectContaining({ type: 'tool-input-error', toolCallId: 'call-missing' })
        );
        expect(result.chunks.some((c) => c.type === 'error')).toBe(false);
        expect(promptText(model, 1)).toContain('not_a_tool');
        expectStopReason(result, undefined);
        await vi.waitFor(async () => {
            const reply = (await getConversationStore().get(sessionId))?.messages.at(-1);
            expect(reply?.content).toBe('已改用其他方式回答');
            expect((reply?.metadata as Record<string, unknown> | undefined)?.stopReason).toBeUndefined();
        });
    });

    it('feeds the expanded command to the model but persists the original text with the snapshot', async () => {
        await getCommandStore().save('summary', { body: '请用三点总结：$ARGUMENTS' });
        const model = useScript([{ text: '1. 2. 3.' }]);
        const sessionId = randomUUID();
        const result = await runScenarioTurn({ messages: [userMessage('/summary 今天的工作')], sessionId });
        expectToolSequence(result, []);
        expect(promptText(model)).toContain('请用三点总结：今天的工作');
        expect(promptText(model)).not.toContain('/summary');
        await vi.waitFor(async () => {
            const saved = await getConversationStore().get(sessionId);
            expect(saved?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
            expect(saved?.messages[0].content).toBe('/summary 今天的工作');
        });
    });
});
