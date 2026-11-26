import type * as AiSdk from 'ai';
import type { ModelMessage, toolSearch, ToolExecutionOptions, ToolLoopAgent, ToolSet } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ContextSection } from '@/agent/context/builder';
import type * as ProviderModule from '@/agent/model/provider';
import type { MemoryToolContext, MemoryToolDeps } from '@/agent/tools/memory-tools';
import type { ResolvedModel } from '@/config/types';
import {
    createChannelRunAgent,
    createProgressiveAgent,
    createRoutedAgent,
    type AgentWorkspace,
    type HistoryMessage
} from '@/modules/chat/agents/runner';
import type { MCPToolAdapter, MCPToolDiscovery } from '@/modules/mcp';
import type { LoadedSkill, SkillMetadata, SkillRegistry } from '@/modules/skills';

// 仅替换 SDK 执行边界：runner、技能加载/绑定、提示词拼装和 prepareStep 压缩都执行真实实现。
type AgentSettings = ConstructorParameters<typeof ToolLoopAgent>[0];
const state = vi.hoisted(() => ({
    agents: [] as AgentSettings[],
    stream: vi.fn(),
    toUIMessageStream: vi.fn(),
    createModel: vi.fn(),
    activeModel: vi.fn(),
    shell: vi.fn(),
    web: vi.fn(),
    memory: vi.fn(),
    interaction: vi.fn(),
    tasks: vi.fn(),
    subagent: vi.fn(),
    sections: vi.fn<() => ContextSection[]>(),
    memorySettings: vi.fn(),
    webSettings: vi.fn(),
    appSettings: vi.fn(),
    danger: vi.fn(),
    broker: { resolveBash: vi.fn(), resolveWrite: vi.fn() },
    policy: { evaluate: vi.fn(), grepExcludeGlobs: vi.fn() },
    writeDenylisted: vi.fn(),
    audit: vi.fn(),
    recorder: vi.fn(),
    getTaskStore: vi.fn(),
    getMemoryStore: vi.fn(),
    resolveMemoryRoot: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('ai', async (importOriginal) => {
    const actual = await importOriginal<typeof AiSdk>();
    return {
        ...actual,
        ToolLoopAgent: class {
            constructor(settings: AgentSettings) {
                state.agents.push(settings);
            }
            stream = state.stream;
        },
        toUIMessageStream: state.toUIMessageStream
    };
});
vi.mock('@/agent/model/provider', async (importOriginal) => ({
    ...(await importOriginal<typeof ProviderModule>()),
    createModel: state.createModel
}));
vi.mock('@/config/model', () => ({ activeModel: state.activeModel, RESPONSE_TIMEOUT_MS: 60_000 }));
vi.mock('@/config/settings-store', () => ({
    getMemorySettings: state.memorySettings,
    getWebSettings: state.webSettings,
    getAppSettings: state.appSettings,
    getPersonaSettings: () => ({})
}));
vi.mock('@/config/danger-mode', () => ({ isDangerouslySkipPermissions: state.danger }));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => state.log }));
vi.mock('@/agent/tools/shell-tools', () => ({ createShellTools: state.shell }));
vi.mock('@/agent/tools/web-tools', () => ({ createWebTools: state.web }));
vi.mock('@/agent/tools/memory-tools', () => ({ createMemoryTools: state.memory }));
vi.mock('@/agent/tools/interaction-tools', () => ({ createInteractionTools: state.interaction }));
vi.mock('@/agent/tools/task-tools', () => ({ createTaskTools: state.tasks }));
vi.mock('@/agent/tools/subagent-tools', () => ({ createSubagentTools: state.subagent }));
vi.mock('@/modules/chat/context', () => ({ createChatSections: state.sections }));
vi.mock('@/modules/permission', () => ({
    createPermissionBroker: () => state.broker,
    getPolicyEngine: () => state.policy,
    isWriteDenylisted: state.writeDenylisted,
    recordPermissionAudit: state.audit
}));
vi.mock('@/modules/conversations', () => ({ getCheckpointStore: () => ({ recorder: state.recorder }) }));
vi.mock('@/modules/tasks', () => ({ getTaskStore: state.getTaskStore }));
vi.mock('@/modules/memory', () => ({
    getMemoryStore: state.getMemoryStore,
    resolveMemoryRoot: state.resolveMemoryRoot
}));

const config: ResolvedModel = {
    kind: 'openai-compatible',
    baseURL: 'https://model.invalid',
    apiKey: 'unit-test-only',
    modelName: 'test-model',
    contextWindow: 100_000
};

function fakeTool(description: string): ToolSet[string] {
    return { description, inputSchema: z.object({}), execute: vi.fn(async () => description) };
}

function skill(id: string, overrides: Partial<LoadedSkill> = {}): LoadedSkill {
    return {
        id,
        name: id,
        description: `${id} description`,
        systemPrompt: `${id} instructions`,
        tools: {},
        toolInfo: [],
        ...overrides
    };
}

function fixture(skills: LoadedSkill[] = []) {
    const adapter = { getAllTools: vi.fn(async (): Promise<ToolSet> => ({})) };
    const discovery = { searchTools: vi.fn(async () => [] as Array<{ server: string; name: string }>) };
    const metadata: SkillMetadata[] = skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        dirPath: `/fake/skills/${s.id}`,
        loaded: true,
        source: 'user',
        editable: true,
        disabled: false
    }));
    const registry = {
        getCatalog: vi.fn(() => 'CATALOG: all enabled skills'),
        loadEnabled: vi.fn(async () => skills),
        getUserSkillDirNames: vi.fn(() => ({ enabled: ['enabled-dir'], disabled: ['disabled-dir'] })),
        getSkillsDir: vi.fn(() => '/fake/skills'),
        getMCPAdapter: vi.fn(() => adapter),
        get: vi.fn(async (id: string) => skills.find((s) => s.id === id) ?? null),
        getMetadataById: vi.fn((id: string) => metadata.find((s) => s.id === id)),
        listMetadata: vi.fn(() => metadata),
        listResourceFiles: vi.fn(async () => ['references/guide.md'])
    };
    // registry/adapter/discovery 是端口替身，不实例化扫描目录或连接 MCP 的生产类。
    const registryPort = registry as unknown as SkillRegistry;
    const adapterPort = adapter as unknown as MCPToolAdapter;
    const discoveryPort = discovery as unknown as MCPToolDiscovery;
    return { registry, registryPort, adapter, adapterPort, discovery, discoveryPort };
}

function lastAgent(): AgentSettings & { tools: ToolSet } {
    const agent = state.agents.at(-1);
    expect(agent).toBeDefined();
    expect(agent?.tools).toBeDefined();
    expect(agent?.repairToolCall).toBeTypeOf('function');
    return agent as AgentSettings & { tools: ToolSet };
}

async function execute(tools: ToolSet, name: string, input: unknown) {
    const executeTool = tools[name]?.execute;
    expect(executeTool, `${name} 必须是真正可执行的工具`).toBeTypeOf('function');
    const callable = executeTool as (input: unknown, options: ToolExecutionOptions<unknown>) => unknown;
    return callable(input, { toolCallId: 'test-call', messages: [], context: {} });
}

async function progressive(f: ReturnType<typeof fixture>, history?: HistoryMessage[]) {
    return createProgressiveAgent(
        f.registryPort,
        config,
        f.adapterPort,
        f.discoveryPort,
        'session',
        'project',
        undefined,
        history,
        'latest question',
        'turn'
    );
}

beforeEach(() => {
    vi.resetAllMocks();
    state.agents.length = 0;
    state.createModel.mockReturnValue({ modelId: 'captured-model' });
    state.activeModel.mockReturnValue(config);
    state.memorySettings.mockReturnValue({ enabled: false });
    state.webSettings.mockReturnValue({ enabled: true, fetchEnabled: true, requireApproval: 'never' });
    state.appSettings.mockReturnValue({
        autoCompactEnabled: true,
        autoCompactThreshold: 80,
        maxAgentSteps: 40,
        repeatErrorLimit: 3,
        modelMaxRetries: 3,
        promptCaching: true
    });
    state.danger.mockReturnValue(false);
    state.broker.resolveBash.mockResolvedValue('user-approval');
    state.broker.resolveWrite.mockResolvedValue('approved');
    state.policy.evaluate.mockResolvedValue({ decision: 'none' });
    state.policy.grepExcludeGlobs.mockResolvedValue(['!**/.env']);
    state.writeDenylisted.mockReturnValue(false);
    state.recorder.mockReturnValue({ checkpoint: 'test-recorder' });
    state.getTaskStore.mockReturnValue({ taskStore: 'test-task-store' });
    state.shell.mockResolvedValue({
        Bash: fakeTool('shell Bash'),
        Read: fakeTool('shell Read'),
        Write: fakeTool('shell Write'),
        Edit: fakeTool('shell Edit'),
        Grep: fakeTool('shell Grep'),
        Glob: fakeTool('shell Glob'),
        LS: fakeTool('shell LS')
    });
    state.web.mockReturnValue({ WebFetch: fakeTool('web') });
    state.memory.mockReturnValue({ read_memory: fakeTool('memory') });
    state.interaction.mockReturnValue({ askUserQuestion: fakeTool('interaction') });
    state.tasks.mockReturnValue({ TaskList: fakeTool('tasks') });
    state.subagent.mockReturnValue({ Task: fakeTool('subagent') });
    state.sections.mockReturnValue([]);
    state.stream.mockResolvedValue({ stream: new ReadableStream({ start: (controller) => controller.close() }) });
    state.toUIMessageStream.mockReturnValue({ ui: 'converted-stream' });
});

describe('chat runner / routed composition', () => {
    it('组装工具优先级、preset、完整目录、项目上下文以及 checkpoint/subagent 接线', async () => {
        const mcpRead = fakeTool('MCP wins');
        const kept = skill('kept', {
            tools: { custom: fakeTool('kept'), Read: fakeTool('skill loses to shell') },
            toolInfo: [
                { name: 'custom', description: '' },
                { name: 'custom', description: '' }
            ]
        });
        const f = fixture([kept, skill('excluded', { tools: { excluded: fakeTool('not mounted') } })]);
        f.adapter.getAllTools.mockResolvedValue({ Read: mcpRead, server_lookup: fakeTool('MCP lookup') });
        const sectionBuild = vi.fn(async () => 'PROJECT CONTEXT');
        state.sections.mockReturnValue([{ id: 'project', order: 20, build: sectionBuild }]);
        const workspace: AgentWorkspace = {
            primaryDir: '/project',
            additionalDirs: ['/extra'],
            warnings: ['missing root omitted'],
            trusted: true
        };

        await createRoutedAgent(
            f.registryPort,
            config,
            f.adapterPort,
            'session',
            'project',
            ['kept'],
            workspace,
            'latest question',
            'turn'
        );

        const agent = lastAgent();
        expect(state.createModel).toHaveBeenCalledWith(config);
        expect(agent.model).toBe(state.createModel.mock.results[0].value);
        expect(agent.tools.Read).toBe(mcpRead);
        expect(agent.tools.custom).toBe(kept.tools.custom);
        expect(agent.tools).not.toHaveProperty('excluded');
        expect(Object.keys(agent.tools)).toEqual(
            expect.arrayContaining([
                'load_skill',
                'list_skills',
                'create_skill',
                'update_skill',
                'Bash',
                'WebFetch',
                'Task',
                'TaskList',
                'askUserQuestion'
            ])
        );
        expect(agent.tools).not.toHaveProperty('read_memory');
        expect(state.shell).toHaveBeenCalledWith('/fake/skills', {
            primaryDir: '/project',
            additionalDirs: ['/extra'],
            enabledSkillDirs: ['enabled-dir'],
            disabledSkillDirs: ['disabled-dir'],
            checkpoint: { checkpoint: 'test-recorder' },
            grepExcludeGlobs: ['!**/.env']
        });
        expect(state.recorder).toHaveBeenCalledWith('session', 'turn');
        expect(state.tasks).toHaveBeenCalledWith({ taskStore: 'test-task-store' }, 'session');
        expect(state.subagent).toHaveBeenCalledWith({
            registry: f.registryPort,
            modelConfig: config,
            shellTools: await state.shell.mock.results[0].value,
            sessionId: 'session',
            toolApproval: expect.any(Function)
        });
        expect(sectionBuild).toHaveBeenCalledWith({
            projectId: 'project',
            sessionId: 'session',
            latestUserText: 'latest question'
        });
        expect(agent.instructions).toContain('CATALOG: all enabled skills');
        expect(agent.instructions).toContain('### 本地技能工具\ncustom');
        expect(agent.instructions).not.toContain('custom、custom');
        expect(agent.instructions).toContain('`/project`');
        expect(agent.instructions).toContain('`/extra`');
        expect(agent.instructions).toContain('注意：missing root omitted');
        expect(agent.instructions).toContain('### 内置工具（Web 访问）\nWebFetch');
        expect(agent.instructions).toContain('Read、server_lookup');
        expect(agent.instructions).toContain('PROJECT CONTEXT');
        expect(agent.prepareCall).toBeUndefined();
    });

    it.each([undefined, []])('未限定 preset %j 时加载所有启用技能，缺失 tools/toolInfo 可跳过', async (preset) => {
        const f = fixture([
            skill('one', { tools: { first: fakeTool('first') } }),
            skill('two', { tools: { second: fakeTool('second') } }),
            { id: 'sparse' } as LoadedSkill
        ]);
        await createRoutedAgent(f.registryPort, config, undefined, undefined, undefined, preset);
        expect(lastAgent().tools).toHaveProperty('first');
        expect(lastAgent().tools).toHaveProperty('second');
        expect(lastAgent().instructions).toContain('工作目录是临时工作区');
        expect(lastAgent().instructions).not.toContain('### MCP 工具');
    });

    it.each([new Error('MCP unavailable'), 'MCP rejected'])('MCP 错误 %s 不阻断，错误原因进入提示词', async (error) => {
        const f = fixture();
        f.adapter.getAllTools.mockRejectedValue(error);
        await createRoutedAgent(f.registryPort, config, f.adapterPort, undefined, undefined, undefined, {
            primaryDir: '/project'
        });
        expect(lastAgent().tools).toHaveProperty('Bash');
        expect(lastAgent().instructions).toContain(error instanceof Error ? error.message : error);
        expect(lastAgent().instructions).not.toContain('该项目还包含附加目录');
        expect(state.log.error).toHaveBeenCalledWith('加载 MCP 工具失败', { err: error });
    });

    it('shell、Web 和上下文段初始化失败分别降级，仍构建可用 agent', async () => {
        state.shell.mockRejectedValue(new Error('shell unavailable'));
        state.web.mockImplementation(() => {
            throw new Error('web unavailable');
        });
        const error = new Error('context unavailable');
        state.sections.mockReturnValue([
            {
                id: 'broken',
                order: 10,
                build: async () => {
                    throw error;
                }
            },
            { id: 'good', order: 20, build: async () => 'SURVIVING CONTEXT' }
        ]);
        await createRoutedAgent(fixture().registryPort, config);
        const agent = lastAgent();
        expect(agent.tools).not.toHaveProperty('Bash');
        expect(agent.tools).not.toHaveProperty('WebFetch');
        expect(agent.instructions).not.toContain('### 内置工具');
        expect(agent.instructions).toContain('SURVIVING CONTEXT');
        expect(state.log.error).toHaveBeenCalledWith('上下文段注入失败，本轮跳过', { section: 'broken', err: error });
    });

    it.each([
        { enabled: false, fetchEnabled: true },
        { enabled: true, fetchEnabled: false }
    ])('Web 配置 %j 时不创建工具也不宣传 Web 能力', async (settings) => {
        state.webSettings.mockReturnValue(settings);
        await createRoutedAgent(fixture().registryPort, config);
        expect(state.web).not.toHaveBeenCalled();
        expect(lastAgent().tools).not.toHaveProperty('WebFetch');
        expect(lastAgent().instructions).not.toContain('### 内置工具（Web 访问）');
    });

    it('启用记忆时按 project/session 注入工具依赖，根目录按 scope 惰性解析', async () => {
        state.memorySettings.mockReturnValue({ enabled: true });
        state.resolveMemoryRoot.mockReturnValue('/fake/project-memory');
        const store = { memoryStore: 'fake' };
        state.getMemoryStore.mockReturnValue(store);
        await createRoutedAgent(fixture().registryPort, config, undefined, 'session', 'project');
        expect(lastAgent().tools).toHaveProperty('read_memory');
        const [deps, ctx] = state.memory.mock.calls[0] as [MemoryToolDeps, MemoryToolContext];
        expect(ctx).toEqual({ projectId: 'project', sessionId: 'session' });
        expect(state.getMemoryStore).not.toHaveBeenCalled();
        expect(deps.storeOf('project')).toBe(store);
        expect(state.resolveMemoryRoot).toHaveBeenCalledWith('project', 'project');
        expect(deps.storeOf('global')).toBe(store);
        expect(state.resolveMemoryRoot).toHaveBeenLastCalledWith('global', 'project');
    });
});

// generic 审批函数：按「工具名 → 调用」包一层，便于逐工具断言 fallback 映射（保持改造前 map 语义）。
type ApprovalFn = (o: { toolCall: { toolName: string; input: unknown } }) => Promise<unknown>;
function approvalFn(agent = lastAgent()): ApprovalFn {
    return agent.toolApproval as unknown as ApprovalFn;
}
function approvals(agent = lastAgent()) {
    const fn = approvalFn(agent);
    return new Proxy({} as Record<string, (input?: unknown) => Promise<unknown>>, {
        get: (_target, toolName: string) => (input?: unknown) => fn({ toolCall: { toolName, input } })
    });
}

describe('chat runner / approval and step callbacks', () => {
    it.each(['routed', 'progressive'] as const)('%s 将命令/路径与信任根交给同一个 broker', async (mode) => {
        const f = fixture();
        const workspace: AgentWorkspace = { trusted: true, primaryDir: '/project', additionalDirs: ['/extra', ''] };
        if (mode === 'routed') {
            await createRoutedAgent(f.registryPort, config, undefined, 'session', undefined, undefined, workspace);
        } else {
            await createProgressiveAgent(
                f.registryPort,
                config,
                f.adapterPort,
                f.discoveryPort,
                'session',
                undefined,
                workspace
            );
        }
        const approval = approvals();
        const ctx = { sessionId: 'session', trust: { roots: ['/project', '/extra'] } };
        expect(await approval.Bash({ command: 'printf test' })).toBe('user-approval');
        expect(state.broker.resolveBash).toHaveBeenLastCalledWith('printf test', ctx);
        expect(await approval.Write({ file_path: '/project/new.txt' })).toBe('approved');
        expect(await approval.Edit({ file_path: '/project/old.txt' })).toBe('approved');
        expect(state.broker.resolveWrite).toHaveBeenNthCalledWith(1, '/project/new.txt', ctx);
        expect(state.broker.resolveWrite).toHaveBeenNthCalledWith(2, '/project/old.txt', ctx);
        expect(await approval.create_skill()).toBe('user-approval');
        expect(await approval.update_skill()).toBe('user-approval');
        expect(await approval.connector_cli_tencent_meeting({ args: ['meeting', 'create'] })).toBe('user-approval');
        expect(await approval.WebFetch()).toBe('approved');
        state.webSettings.mockReturnValue({ requireApproval: 'always' });
        expect(await approval.WebFetch()).toBe('user-approval');
    });

    it.each([
        undefined,
        {},
        { trusted: false, primaryDir: '/project' },
        { trusted: true },
        { trusted: true, primaryDir: '' }
    ])('workspace %j 不产生空的或未获信任的 roots', async (workspace) => {
        await createRoutedAgent(fixture().registryPort, config, undefined, undefined, undefined, undefined, workspace);
        await approvals().Bash({ command: 'test' });
        expect(state.broker.resolveBash).toHaveBeenCalledWith('test', { sessionId: undefined, trust: undefined });
    });

    it('仅有 additionalDirs 的受信任工作区仍传递有效 roots', async () => {
        await createRoutedAgent(fixture().registryPort, config, undefined, undefined, undefined, undefined, {
            trusted: true,
            additionalDirs: ['/extra']
        });
        await approvals().Write({ file_path: '/extra/file' });
        expect(state.broker.resolveWrite).toHaveBeenCalledWith('/extra/file', {
            sessionId: undefined,
            trust: { roots: ['/extra'] }
        });
    });

    it('异常工具输入转换成空字符串，数值字段安全转为字符串', async () => {
        await createRoutedAgent(fixture().registryPort, config);
        for (const input of [undefined, null, 'command', 123, {}, { command: null }, { command: undefined }]) {
            await approvals().Bash(input);
            expect(state.broker.resolveBash).toHaveBeenLastCalledWith('', { sessionId: undefined, trust: undefined });
        }
        await approvals().Bash({ command: 42 });
        expect(state.broker.resolveBash).toHaveBeenLastCalledWith('42', { sessionId: undefined, trust: undefined });
        await approvals().Write(null);
        await approvals().Edit({ file_path: 7 });
        expect(state.broker.resolveWrite).toHaveBeenNthCalledWith(1, '', { sessionId: undefined, trust: undefined });
        expect(state.broker.resolveWrite).toHaveBeenNthCalledWith(2, '7', { sessionId: undefined, trust: undefined });
    });

    it('其它工具 not-applicable；Write 读 bash-tool 的 path 字段，Edit 读 file_path', async () => {
        await createRoutedAgent(fixture().registryPort, config, undefined, 'session', undefined, undefined, {
            primaryDir: '/project'
        });
        for (const name of ['Read', 'Grep', 'Glob', 'LS', 'Task', 'TaskList', 'askUserQuestion', 'mcp_tool']) {
            expect(await approvals()[name]({})).toBe('not-applicable');
        }
        await approvals().Write({ path: '/project/a.txt', content: 'x' });
        expect(state.broker.resolveWrite).toHaveBeenLastCalledWith('/project/a.txt', {
            sessionId: 'session',
            trust: undefined
        });
        expect(state.policy.evaluate).toHaveBeenCalledWith('Read', {}, expect.objectContaining({ cwd: '/project' }));
        // 交互工具豁免策略：不进 evaluate
        expect(state.policy.evaluate).not.toHaveBeenCalledWith('askUserQuestion', expect.anything(), expect.anything());
    });

    it('策略 deny / ask / allow 先于 broker，危险模式下 deny 仍生效且写审计', async () => {
        await createRoutedAgent(fixture().registryPort, config, undefined, 'session');
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'deny', reason: '被权限规则 Read(**/.env) 拒绝' });
        expect(await approvals().Read({ path: '.env' })).toEqual({
            type: 'denied',
            reason: '被权限规则 Read(**/.env) 拒绝'
        });
        expect(state.audit).toHaveBeenLastCalledWith(
            expect.objectContaining({ sessionId: 'session', toolName: 'Read', decision: expect.any(Object) })
        );
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'ask', reason: '命中 Bash(git push:*)' });
        expect(await approvals().Bash({ command: 'git push' })).toEqual({
            type: 'user-approval',
            reason: '命中 Bash(git push:*)'
        });
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'allow', reason: 'allow rule' });
        expect(await approvals().Bash({ command: 'make' })).toEqual({ type: 'approved', reason: 'allow rule' });
        expect(state.broker.resolveBash).not.toHaveBeenCalled();
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'allow' });
        state.writeDenylisted.mockReturnValueOnce(true);
        expect(await approvals().Write({ path: '/etc/hosts' })).toMatchObject({ type: 'user-approval' });
        expect(state.writeDenylisted).toHaveBeenLastCalledWith('/etc/hosts');
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'allow' });
        expect(await approvals().Edit({})).toMatchObject({ type: 'user-approval' });

        state.danger.mockReturnValue(true);
        await createRoutedAgent(fixture().registryPort, config);
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'deny', reason: 'deny' });
        expect(await approvals().Read({ path: '.env' })).toMatchObject({ type: 'denied' });
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'ask', reason: 'ask' });
        expect(await approvals().Bash({ command: 'rm x' })).toMatchObject({ type: 'approved' });
    });

    it('子 agent 与渠道无确认 UI：策略 ask 与 broker 的 user-approval 都转 denied', async () => {
        await createRoutedAgent(fixture().registryPort, config, undefined, 'session');
        const subApproval = state.subagent.mock.calls[0][0].toolApproval as ApprovalFn;
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'ask', reason: 'ask' });
        expect(await subApproval({ toolCall: { toolName: 'Read', input: {} } })).toMatchObject({ type: 'denied' });
        expect(await subApproval({ toolCall: { toolName: 'Bash', input: { command: 'x' } } })).toMatchObject({
            type: 'denied'
        });
        expect(
            await subApproval({
                toolCall: { toolName: 'connector_cli_tencent_meeting', input: { args: ['meeting', 'list'] } }
            })
        ).toMatchObject({ type: 'denied' });
        expect(await subApproval({ toolCall: { toolName: 'Grep', input: {} } })).toBe('not-applicable');

        const f = fixture();
        f.adapter.getAllTools.mockResolvedValue({ github_search: fakeTool('mcp') });
        await createChannelRunAgent(f.registryPort)([], { sessionId: 'channel' });
        state.policy.evaluate.mockResolvedValueOnce({ decision: 'ask', reason: 'ask' });
        expect(await approvals().github_search({})).toMatchObject({ type: 'denied' });
        const ctx = state.policy.evaluate.mock.calls.at(-1)![2] as { isMcpTool: (n: string) => boolean };
        expect(ctx.isMcpTool('github_search')).toBe(true);
        expect(ctx.isMcpTool('load_skill')).toBe(false);
    });

    it.each(['routed', 'progressive'] as const)('%s 用 PostToolUse 包装工具，PreToolUse 进审批管线', async (mode) => {
        const f = fixture();
        const hooks = {
            matches: vi.fn((event: string, name: string) => name === (event === 'PreToolUse' ? 'Bash' : 'Grep')),
            pre: vi.fn(async () => ({ decision: 'deny' as const, reason: 'blocked' })),
            post: vi.fn(async () => ({ additionalContext: 'ctx' }))
        };
        if (mode === 'routed') {
            await createRoutedAgent(
                f.registryPort,
                config,
                undefined,
                's',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { hooks }
            );
        } else {
            await createProgressiveAgent(
                f.registryPort,
                config,
                f.adapterPort,
                f.discoveryPort,
                's',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { hooks }
            );
        }
        const agent = lastAgent();
        const grep = agent.tools!.Grep as { execute: (i: unknown, o: unknown) => Promise<unknown> };
        expect(await grep.execute({}, { toolCallId: 'c' })).toBe('shell Grep\n\n[hook]\nctx');
        expect(await approvals().Bash({ command: 'ls' })).toEqual({
            type: 'denied',
            reason: 'PreToolUse hook 拒绝：blocked'
        });
    });

    it('危险启动态仅让技能审批自动通过，不绕过 Web 的逐次确认设置', async () => {
        state.danger.mockReturnValue(true);
        state.webSettings.mockReturnValue({ enabled: true, fetchEnabled: true, requireApproval: 'always' });
        await createRoutedAgent(fixture().registryPort, config);
        expect(await approvals().create_skill()).toBe('approved');
        expect(await approvals().update_skill()).toBe('approved');
        expect(await approvals().WebFetch()).toBe('user-approval');
    });

    it.each(['routed', 'progressive'] as const)(
        '%s 挂载的真实 prepareStep 按阈值清理旧推理而不调用模型',
        async (mode) => {
            const f = fixture();
            if (mode === 'routed') await createRoutedAgent(f.registryPort, config);
            else await progressive(f);
            // runner 未注册 onStepStart/onStepEnd/onStepFinish；不能凭空测试不存在的 hook。
            const agent = lastAgent();
            expect(agent.onStepStart).toBeUndefined();
            expect(agent.onStepEnd).toBeUndefined();
            expect(agent).not.toHaveProperty('onStepFinish');
            const prepareStep = agent.prepareStep as (input: {
                messages: ModelMessage[];
                steps: Array<{ usage: { totalTokens: number } }>;
            }) => Promise<{ messages: ModelMessage[] } | undefined>;
            const messages: ModelMessage[] = [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: [{ type: 'reasoning', text: 'old reasoning' }] },
                { role: 'user', content: 'latest' },
                { role: 'assistant', content: 'latest answer' }
            ];
            expect(await prepareStep({ messages, steps: [] })).toBeUndefined();
            const result = await prepareStep({ messages, steps: [{ usage: { totalTokens: 100_000 } }] });
            expect(result?.messages).toEqual([messages[0], messages[2], messages[3]]);
            expect(messages).toHaveLength(4);
            state.appSettings.mockReturnValue({ autoCompactEnabled: false });
            expect(await prepareStep({ messages, steps: [{ usage: { totalTokens: 100_000 } }] })).toBeUndefined();
            expect(state.stream).not.toHaveBeenCalled();
        }
    );
});

describe('chat runner / progressive live tools and history', () => {
    it('种子仅含只读检索/Web/Task，MCP schema 以副本 deferred 常驻', async () => {
        const f = fixture([skill('not-eager', { tools: { custom: fakeTool('not eager') } })]);
        const raw = fakeTool('raw MCP');
        f.adapter.getAllTools.mockResolvedValue({ server_tool: raw });
        await progressive(f);
        const agent = lastAgent();
        expect(Object.keys(agent.tools)).toEqual(
            expect.arrayContaining(['Grep', 'Glob', 'LS', 'WebFetch', 'Task', 'search', 'create_skill', 'update_skill'])
        );
        for (const name of ['Bash', 'Read', 'Write', 'Edit', 'custom']) expect(agent.tools).not.toHaveProperty(name);
        expect(agent.tools.server_tool).toEqual({ ...raw, deferLoading: true });
        expect(agent.tools.server_tool).not.toBe(raw);
        expect(raw).not.toHaveProperty('deferLoading');
        expect(f.registry.loadEnabled).not.toHaveBeenCalled();
        expect(state.recorder).toHaveBeenCalledWith('session', 'turn');
        expect(agent.instructions).toContain('CATALOG: all enabled skills');
        expect(agent.instructions).toContain('本模式默认没有 Bash/Read/Write');
    });

    it('实际执行 load_skill 后 prepareCall 与初始 tools 保持同一引用，立即可调新工具', async () => {
        const custom = fakeTool('custom execution');
        const ownRead = fakeTool('skill Read overrides binding');
        const mcp = fakeTool('MCP original');
        const f = fixture([
            skill('dynamic', {
                tools: { custom, Read: ownRead },
                allowedTools: ['Bash', 'Read', 'Write', 'WebFetch', 'mcp__server__tool'],
                disallowedTools: ['Write']
            })
        ]);
        f.adapter.getAllTools.mockResolvedValue({ server_tool: mcp });
        await progressive(f);
        const agent = lastAgent();
        const prepareCall = agent.prepareCall!;
        const messages: ModelMessage[] = [{ role: 'user', content: 'question' }];
        const input: Parameters<typeof prepareCall>[0] = {
            model: agent.model,
            messages,
            tools: { replaced: fakeTool('must not survive') },
            toolsContext: {},
            options: undefined,
            temperature: 0.2
        };
        const before = await prepareCall(input);
        expect(before.tools).toBe(agent.tools);
        expect(before.messages).toBe(messages);
        expect(before.temperature).toBe(0.2);
        expect(before).not.toHaveProperty('options');
        expect(before.tools).not.toHaveProperty('replaced');
        expect(before.tools).not.toHaveProperty('Bash');
        const loaded = await execute(agent.tools, 'load_skill', { skillId: 'dynamic' });
        expect(loaded).toMatchObject({
            success: true,
            availableTools: expect.arrayContaining(['Bash', 'Read', 'WebFetch', 'server_tool', 'custom'])
        });
        // 不重建 agent、不再次 prepareCall：正在使用的同一个工具引用已包含新加载工具。
        expect(before.tools?.custom).toBe(custom);
        expect(before.tools?.Read).toBe(ownRead);
        expect(before.tools?.server_tool).toBe(mcp);
        expect(before.tools?.server_tool).not.toHaveProperty('deferLoading');
        expect(before.tools).not.toHaveProperty('Write');
        expect(await execute(before.tools!, 'custom', {})).toBe('custom execution');
        const after = await prepareCall(input);
        expect(after.tools).toBe(before.tools);
        expect(f.adapter.getAllTools).toHaveBeenCalledTimes(2);
        expect(f.registry.get).toHaveBeenCalledWith('dynamic');
    });

    it('历史 load_skill 去重预挂载，忽略无关/异常记录并按绑定规则恢复续跑工具', async () => {
        const custom = fakeTool('own');
        const ownRead = fakeTool('own read');
        const mcp = fakeTool('MCP');
        const f = fixture([
            skill('history', {
                tools: { custom, Read: ownRead },
                allowedTools: ['Bash', 'Read', 'Write', 'WebFetch', 'mcp__server__tool'],
                disallowedTools: ['Write']
            }),
            { id: 'no-tools' } as LoadedSkill,
            skill('empty-allowed', { allowedTools: [] })
        ]);
        f.adapter.getAllTools.mockResolvedValue({ server_tool: mcp });
        await progressive(f, [
            {},
            {
                parts: [
                    {},
                    { type: 'tool-search', input: { skillId: 'unrelated' } },
                    { type: 'tool-load_skill' },
                    { type: 'tool-load_skill', input: null },
                    { type: 'tool-load_skill', input: 'history' },
                    { type: 'tool-load_skill', input: {} },
                    { type: 'tool-load_skill', input: { skillId: 123 } },
                    { type: 'tool-load_skill', input: { skillId: '' } },
                    ...['history', 'HISTORY', 'history', 'missing', 'no-tools', 'empty-allowed'].map((skillId) => ({
                        type: 'tool-load_skill',
                        input: { skillId }
                    }))
                ]
            }
        ]);
        const agent = lastAgent();
        expect(agent.tools.custom).toBe(custom);
        expect(agent.tools.Read).toBe(ownRead);
        expect(agent.tools).toHaveProperty('Bash');
        expect(agent.tools).not.toHaveProperty('Write');
        expect(agent.tools.server_tool).toBe(mcp);
        expect(f.registry.get.mock.calls.map(([id]) => id)).toEqual([
            'history',
            'missing',
            'no-tools',
            'empty-allowed'
        ]);
        expect(f.adapter.getAllTools).toHaveBeenCalledTimes(2);
    });

    it.each<{ history: HistoryMessage[] }>([{ history: [] }, { history: [{}, { parts: [{ type: 'tool-search' }] }] }])(
        '历史 $history 无 load_skill 时不额外读取候选池',
        async ({ history }) => {
            const f = fixture();
            await progressive(f, history);
            expect(f.adapter.getAllTools).toHaveBeenCalledTimes(1);
            expect(f.registry.get).not.toHaveBeenCalled();
        }
    );

    it('MCP 池和单个历史技能加载失败时继续恢复其它技能，shell 不受影响', async () => {
        const f = fixture([skill('good', { tools: { custom: fakeTool('survivor') }, allowedTools: ['Bash'] })]);
        f.adapter.getAllTools.mockRejectedValue(new Error('MCP unavailable'));
        f.registry.get.mockImplementation(async (id) => {
            if (id === 'broken') throw new Error('skill unavailable');
            return skill('good', { tools: { custom: fakeTool('survivor') }, allowedTools: ['Bash'] });
        });
        await progressive(f, [
            { parts: ['broken', 'good'].map((skillId) => ({ type: 'tool-load_skill', input: { skillId } })) }
        ]);
        expect(lastAgent().tools).toHaveProperty('Bash');
        expect(lastAgent().tools).toHaveProperty('custom');
        expect(state.log.error).toHaveBeenCalledWith(
            '渐进模式加载 MCP 工具失败，本轮无可发现的 MCP 工具',
            expect.any(Object)
        );
        expect(state.log.error).toHaveBeenCalledWith(
            '预挂载历史工具时加载 MCP 池失败，仅按 shell 解析技能 allowed-tools',
            expect.any(Object)
        );
        expect(state.log.error).toHaveBeenCalledWith(
            '预挂载历史技能工具失败，本轮续跑可能缺该技能工具',
            expect.objectContaining({ skillId: 'broken' })
        );
    });

    it('动态绑定候选池失败仍注入技能自己的工具，不伪造 shell 成功', async () => {
        const f = fixture([skill('own', { tools: { custom: fakeTool('custom') }, allowedTools: ['Bash'] })]);
        f.adapter.getAllTools.mockResolvedValueOnce({}).mockRejectedValue(new Error('binding unavailable'));
        await progressive(f);
        const result = await execute(lastAgent().tools, 'load_skill', { skillId: 'own' });
        expect(result).toMatchObject({ success: true, availableTools: ['custom'] });
        expect(lastAgent().tools).toHaveProperty('custom');
        expect(lastAgent().tools).not.toHaveProperty('Bash');
    });

    it('shell 创建失败时不挂载检索种子，仍可提供 search 与元工具', async () => {
        state.shell.mockRejectedValue(new Error('no shell'));
        await progressive(fixture());
        for (const name of ['Grep', 'Glob', 'LS']) expect(lastAgent().tools).not.toHaveProperty(name);
        expect(lastAgent().tools).toHaveProperty('search');
        expect(lastAgent().tools).toHaveProperty('load_skill');
    });

    it('执行 SDK toolSearch 的真实 custom search 回调：名称规范化并与 eligible 取交集', async () => {
        const f = fixture();
        f.discovery.searchTools.mockResolvedValue([
            { server: 'workspace-server', name: 'read.note' },
            { server: 'other', name: 'hidden' },
            { server: 'workspace-server', name: 'list' }
        ]);
        await progressive(f);
        // AI SDK 7 的 toolSearch 将自定义搜索挂在此公开注册的 Symbol 上，generation 再绑定 execute。
        const searchTool = lastAgent().tools.search as ToolSet[string] & {
            [key: symbol]: unknown;
        };
        const search = searchTool[Symbol.for('vercel.ai.toolSearch.search')] as NonNullable<
            NonNullable<Parameters<typeof toolSearch>[0]>['search']
        >;
        expect(searchTool[Symbol.for('vercel.ai.toolSearch.maxResults')]).toBe(10);
        expect(
            await search({
                query: '报告',
                tools: [{ name: 'workspace_server_read_note' }, { name: 'workspace_server_list' }]
            })
        ).toEqual(['workspace_server_read_note', 'workspace_server_list']);
        expect(f.discovery.searchTools).toHaveBeenCalledWith('报告');
        f.discovery.searchTools.mockRejectedValue(new Error('discovery unavailable'));
        expect(await search({ query: 'fail', tools: [] })).toEqual([]);
        expect(state.log.error).toHaveBeenCalledWith(
            'search 自定义检索失败，本次返回空结果',
            expect.objectContaining({ query: 'fail' })
        );
    });
});

describe('chat runner / channel headless contract', () => {
    it('受限工具集、流参数与惰性 UI stream 转换；load_skill 不会扩大渠道工具集', async () => {
        const own = fakeTool('skill wins');
        const f = fixture([
            skill('allowed', { tools: { lookup: own }, allowedTools: ['Bash'] }),
            skill('excluded', { tools: { excluded: fakeTool('excluded') } })
        ]);
        f.adapter.getAllTools.mockResolvedValue({ lookup: fakeTool('MCP loses'), remote: fakeTool('MCP remote') });
        const messages: ModelMessage[] = [{ role: 'user', content: 'channel question' }];
        const abortSignal = new AbortController().signal;
        const run = createChannelRunAgent(f.registryPort, ['allowed']);
        const result = await run(messages, { sessionId: 'channel-session', abortSignal });
        const agent = lastAgent();
        expect(Object.keys(agent.tools).sort()).toEqual(['list_skills', 'load_skill', 'lookup', 'remote']);
        expect(agent.tools.lookup).toBe(own);
        expect(agent.toolApproval).toEqual(expect.any(Function));
        expect(agent.prepareStep).toBeUndefined();
        expect(agent.prepareCall).toBeUndefined();
        expect(agent.instructions).toContain('无人值守');
        expect(agent.instructions).toContain('CATALOG: all enabled skills');
        expect(agent.instructions).toContain('当前日期');
        expect(state.stream).toHaveBeenCalledWith({ messages, abortSignal });
        expect(state.toUIMessageStream).not.toHaveBeenCalled();
        expect(result.toUIMessageStream()).toBe(state.toUIMessageStream.mock.results[0].value);
        expect(state.toUIMessageStream).toHaveBeenCalledWith({
            stream: (await state.stream.mock.results[0].value).stream
        });
        for (const factory of [
            state.shell,
            state.web,
            state.memory,
            state.tasks,
            state.interaction,
            state.subagent,
            state.recorder,
            state.sections
        ]) {
            expect(factory).not.toHaveBeenCalled();
        }
        expect(await execute(agent.tools, 'load_skill', { skillId: 'excluded' })).toMatchObject({
            success: true,
            instructions: 'excluded instructions',
            availableTools: []
        });
        expect(agent.tools).not.toHaveProperty('excluded');
        expect(agent.tools).not.toHaveProperty('Bash');
    });

    it.each([undefined, []])('白名单 %j 加载所有启用技能，MCP 失败仍能运行', async (allowed) => {
        const f = fixture([skill('one', { tools: { one: fakeTool('one') } }), { id: 'no-tools' } as LoadedSkill]);
        f.adapter.getAllTools.mockRejectedValue(new Error('MCP unavailable'));
        await createChannelRunAgent(f.registryPort, allowed)([], { sessionId: 'channel' });
        expect(lastAgent().tools).toHaveProperty('one');
        expect(lastAgent().tools).not.toHaveProperty('create_skill');
        expect(state.log.error).toHaveBeenCalledWith(
            '渠道 agent 加载 MCP 工具失败，本轮仅用技能工具',
            expect.any(Object)
        );
    });

    it('每次调用重新读取激活模型，支持设置热更新', async () => {
        const run = createChannelRunAgent(fixture().registryPort);
        const updated = { ...config, modelName: 'updated' };
        state.activeModel.mockReturnValueOnce(config).mockReturnValueOnce(updated);
        await run([], { sessionId: 'one' });
        await run([], { sessionId: 'two' });
        expect(state.createModel).toHaveBeenNthCalledWith(1, config);
        expect(state.createModel).toHaveBeenNthCalledWith(2, updated);
    });

    it.each([undefined, { ...config, apiKey: '' }])(
        '缺失激活配置或 key (%j) 时先拒绝，不初始化工具',
        async (active) => {
            const f = fixture();
            state.activeModel.mockReturnValue(active);
            await expect(createChannelRunAgent(f.registryPort)([], { sessionId: 'channel' })).rejects.toThrow(
                '未配置激活模型'
            );
            expect(state.createModel).not.toHaveBeenCalled();
            expect(f.adapter.getAllTools).not.toHaveBeenCalled();
            expect(state.agents).toHaveLength(0);
        }
    );

    it('stream 异常原样传播，不返回虚假成功的 UI stream', async () => {
        const error = new Error('stream rejected');
        state.stream.mockRejectedValue(error);
        await expect(createChannelRunAgent(fixture().registryPort)([], { sessionId: 'channel' })).rejects.toBe(error);
        expect(state.toUIMessageStream).not.toHaveBeenCalled();
    });
});
