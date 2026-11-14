import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ProviderModule from '@/agent/model/provider';
import { addProvider, deleteProvider, listProviders, setActiveModel, updateAppSettings } from '@/config/settings-store';
import { setGoalService, type GoalService } from '@/modules/goal';
import { setJobService, type JobService } from '@/modules/jobs';
import { getPermissionStore } from '@/modules/permission';

import {
    approvalOf,
    fakeRegistry,
    runScenarioTurn,
    toolSequence,
    userMessage,
    scriptedModel
} from '../helpers/scenario';
import type { ScriptStep } from '../helpers/scenario';

/**
 * 无人值守执行轮的安全底线（设计 §8 / §11 风险项）：
 * 定时任务的 headless runner 不挂任何危险/交互/递归工具，删掉的是能力而不是靠审批兜底。
 *
 * 这里只替换模型；工具装配、审批管线与 request 组装都是真实实现。
 */
const scenario = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock('@/agent/model/provider', async (original) => ({
    ...(await original<typeof ProviderModule>()),
    createModel: () => scenario.model
}));
vi.mock('@/config/danger-mode', () => ({
    isDangerouslySkipPermissions: () => false,
    getDangerModeStatus: () => ({ enabled: false })
}));

function useScript(steps: ScriptStep[]) {
    const model = scriptedModel(steps);
    scenario.model = model;
    return model;
}

beforeEach(async () => {
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
});

afterEach(async () => {
    // 落库/标题生成是 onEnd 里的 best-effort 异步任务：等一拍再让全局 teardown 清理临时目录。
    await new Promise((resolve) => setTimeout(resolve, 100));
});

/** 某次模型调用收到的工具名。 */
function toolNamesOf(call: number): string[] {
    const model = scenario.model as { doGenerateCalls?: Array<{ tools?: Array<{ name: string }> }> };
    return (model.doGenerateCalls?.[call]?.tools ?? []).map((t) => t.name);
}

describe('scenario: unattended automation run', () => {
    it('不挂 Bash/Write/交互/记忆，也不挂 Cron/Job/Goal 工具（防递归与自驱）', async () => {
        const { createAutomationRunAgent } = await import('@/modules/chat/agents/runner');
        useScript([{ text: '执行完成' }]);
        const run = createAutomationRunAgent(fakeRegistry());
        const result = await run('整理今天的待办', {});

        // generate 走 doGenerate（helper 固定返回「场景测试」），这里只关心能力面与「能跑完」。
        expect(result.text).toBeTruthy();
        const tools = toolNamesOf(0);
        // 只读元工具（load_skill/list_skills）可以有，危险能力一个都不能有。
        for (const forbidden of [
            'Bash',
            'Write',
            'Edit',
            'Read',
            'Grep',
            'Glob',
            'LS',
            'askUserQuestion',
            'Task',
            'CronCreate',
            'CronUpdate',
            'CronDelete',
            'JobStart',
            'GoalArm'
        ]) {
            expect(tools).not.toContain(forbidden);
        }
    });

    it('模型调用不存在的工具时不会获得危险能力，最终仍以文本结束', async () => {
        const { createAutomationRunAgent } = await import('@/modules/chat/agents/runner');
        useScript([{ toolCalls: [{ name: 'Bash', input: { command: 'rm -rf /' } }] }, { text: '无法执行该操作' }]);
        const run = createAutomationRunAgent(fakeRegistry());
        const result = await run('尝试执行危险命令', {});
        expect(result.text).toBeTruthy();
        expect(toolNamesOf(1)).not.toContain('Bash');
    });
});

describe('scenario: automation create locks the turn', () => {
    it('CronCreate 成功后收走本 turn 全部工具，只允许一次文本确认', async () => {
        const model = useScript([
            {
                toolCalls: [
                    {
                        name: 'CronCreate',
                        input: {
                            title: '每日提醒',
                            prompt: '提醒我整理报告',
                            schedule: { kind: 'after', afterSeconds: 60 }
                        }
                    }
                ]
            },
            { text: '已创建，60 秒后执行。' }
        ]);
        const result = await runScenarioTurn({
            messages: [userMessage('一分钟后提醒我')],
            sessionId: crypto.randomUUID()
        });

        expect(toolSequence(result.chunks)).toEqual(['CronCreate']);
        // 第一轮有工具；第二轮（prepareStep 锁）工具被清空。
        expect((model.doStreamCalls?.[0]?.tools ?? []).length).toBeGreaterThan(0);
        expect(model.doStreamCalls?.[1]?.tools ?? []).toHaveLength(0);
    });
});

describe('scenario: job / goal tools are mounted in interactive agents', () => {
    it('JobStart 挂载在交互式 agent 并立即返回任务', async () => {
        setJobService({
            start: async (input: { title?: string; prompt: string; ownerSessionId?: string }) => ({
                id: '1',
                title: input.title ?? 't',
                prompt: input.prompt,
                ownerSessionId: input.ownerSessionId,
                status: 'queued',
                createdAt: Date.now()
            }),
            list: async () => [],
            get: async () => null,
            cancel: async () => null
        } as unknown as JobService);

        useScript([
            { toolCalls: [{ name: 'JobStart', input: { title: '后台整理', prompt: '整理资料' } }] },
            { text: '已放到后台' }
        ]);
        const result = await runScenarioTurn({ messages: [userMessage('后台跑一下')], sessionId: crypto.randomUUID() });

        expect(toolSequence(result.chunks)).toEqual(['JobStart']);
        expect(approvalOf(result, 'JobStart')).toBe('executed');
    });

    it('GoalArm 挂载在交互式 agent 并写入自驱状态', async () => {
        const arm = vi.fn(() => ({
            sessionId: 's',
            goal: '目标',
            status: 'armed' as const,
            roundsStarted: 0,
            maxRounds: 5
        }));
        setGoalService({
            arm,
            disarm: () => null,
            get: () => null,
            list: () => [],
            start: () => {},
            dispose: () => {}
        } as unknown as GoalService);

        useScript([{ toolCalls: [{ name: 'GoalArm', input: { goal: '把报告写完' } }] }, { text: '已开启自驱' }]);
        const result = await runScenarioTurn({
            messages: [userMessage('你自己做完再告诉我')],
            sessionId: crypto.randomUUID()
        });

        expect(toolSequence(result.chunks)).toEqual(['GoalArm']);
        expect(approvalOf(result, 'GoalArm')).toBe('executed');
        expect(arm).toHaveBeenCalledOnce();
    });
});
