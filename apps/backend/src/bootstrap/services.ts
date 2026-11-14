import path from 'node:path';

import { processMessage, sleep } from '@zhuixun/channels-core';

import { prewarmWindowsShell } from '@/agent/tools/windows-shell';
import { isDangerouslySkipPermissions } from '@/config/danger-mode';
import { ensureDirSafe, paths } from '@/config/paths';
import {
    createScheduler,
    getAutomationStore,
    type AutomationDispatchDeps,
    type AutomationScheduler
} from '@/modules/automation';
import { channelManager } from '@/modules/channels';
import { buildChannelRuntime, registerChannels } from '@/modules/channels';
import {
    configureBackgroundTurns,
    sessionEvents,
    sessionRuntime,
    startBackgroundTurn,
    subscribeSessionEvents
} from '@/modules/chat';
import { createAutomationRunAgent, createChannelRunAgent } from '@/modules/chat/agents/runner';
import { getConversationStore } from '@/modules/conversations';
import { GoalService, setGoalService } from '@/modules/goal';
import { createJobService, setJobService } from '@/modules/jobs';
import { loadMCPConfig, mcpConfigToServerConfigs, MCPClientManager, setConfigResolver } from '@/modules/mcp';
import { SkillRegistry } from '@/modules/skills';
import { createLogger } from '@/platform/logging/index';
import { createRuntimeStatus, type RuntimeStatus } from '@/platform/runtime-status';

const appLog = createLogger('App');
const mcpLog = createLogger('MCP');

/**
 * 服务容器：服务启动时创建一次，替代改造前 `app.ts` 里的模块级 `let registry / mcpManager /
 * mcpConfigPath` 与全局 `runtimeStatus`。
 *
 * 路由通过显式 getter / deps 读取容器，不再从 root 模块 import 可变全局。
 */
export interface ServiceContainer {
    registry: SkillRegistry;
    mcp: MCPClientManager;
    mcpConfigPath: string;
    runtime: RuntimeStatus;
    /** 自动化任务调度器（常驻 in-process 单 timer）。 */
    automationScheduler: AutomationScheduler;
    /** 自驱循环服务（进程本地状态，停机时 dispose）。 */
    goalService: GoalService;
}

let container: ServiceContainer | undefined;

/** 服务异步初始化中时返回 undefined（路由据此返回 503）。 */
export function getContainer(): ServiceContainer | undefined {
    return container;
}

/**
 * 解析 MCP 配置路径。主配置落在用户可写目录 `~/.zhuixun/.mcp.json`（MCP_CONFIG_PATH 可覆盖），
 * 运行时 CRUD（routes/mcp/index.ts 的 persistConfig → saveMCPConfig）写此可写路径——打包形态下
 * resources 只读，写回旧位置会失败。文件不存在时 loadMCPConfig 返回空配置，按无 server 降级。
 */
function resolveMcpConfigPath(): string {
    const userPath = paths.mcpConfigPath();
    ensureDirSafe(path.dirname(userPath), 'mcp-config');
    return userPath;
}

/**
 * 组装技能注册表：解析可写主技能根 + 外部只读根，创建 registry 并首扫。
 *
 * 主技能根：`~/.zhuixun/skills`（SKILLS_USER_DIR 可覆盖）。
 * 外部只读根：兼容 ~/.agents 跨工具技能约定（只发现、不创建、不写入），SKILLS_EXTERNAL_DIRS 可覆盖。
 * 技能根仍必须由此显式传入 SkillRegistry，而非在别处用 import.meta.url 推导（两形态 __dirname 含义不同）。
 */
async function createRegistry(manager: MCPClientManager): Promise<SkillRegistry> {
    const userSkillsDir = paths.skillsDir();
    ensureDirSafe(userSkillsDir, 'user-skills');

    const registry = new SkillRegistry(manager, userSkillsDir, paths.externalSkillDirs());
    await registry.scan();
    return registry;
}

/**
 * 异步连接所有 MCP server，不阻塞 HTTP server 启动；连上后启动 60s 健康检查。
 * 失败只降级并把状态透出到 /health，绝不退进程。
 */
function connectMcpInBackground(manager: MCPClientManager, runtime: RuntimeStatus): void {
    manager
        .connectAll()
        .then(() => {
            runtime.mcp = manager.getStatus();
            manager.startHealthCheck(60_000);

            const failed = manager.getResults().filter((r) => !r.ok);
            if (failed.length > 0) {
                runtime.mcpError = failed.map((r) => `${r.name}: ${r.error}`).join('; ');
                mcpLog.warn('MCP 降级运行', { failedCount: failed.length, detail: runtime.mcpError });
            }

            mcpLog.info('MCP 异步连接完成', { status: runtime.mcp });
        })
        .catch((error) => {
            runtime.mcp = 'failed';
            runtime.mcpError = error instanceof Error ? error.message : String(error);
            mcpLog.error('MCP 异步连接失败', { err: error });
        });
}

/**
 * 初始化全部服务并返回容器。失败直接抛出，由调用方决定是否「降级启动」（server 仍监听端口，
 * /health 返回 503）。
 */
export async function initializeServices(channelPlugins?: Readonly<Record<string, string>>): Promise<ServiceContainer> {
    const runtime = createRuntimeStatus();
    // 尽早解析危险跳过审批模式：内部会打一次启动告警（含来源 / uid / root 守卫），
    // 并固化进程缓存，之后 approval broker 与 /health 读取的是同一结果。
    runtime.dangerSkipPermissions = isDangerouslySkipPermissions();

    const mcpConfigPath = resolveMcpConfigPath();
    const mcpConfig = await loadMCPConfig(mcpConfigPath);
    const mcp = new MCPClientManager(mcpConfigToServerConfigs(mcpConfig));

    // 初始化中途失败也要断开 MCP（可能已 spawn stdio 子进程），否则残留进程会让
    // Windows 安装器误判应用仍在运行。
    let registry: SkillRegistry;
    try {
        registry = await createRegistry(mcp);
    } catch (error) {
        await mcp.disconnectAll().catch(() => undefined);
        throw error;
    }
    runtime.skills = registry.listMetadata().length;

    connectMcpInBackground(mcp, runtime);
    // Windows：后台预探测 shell（pwsh/powershell/cmd）与系统代码页，首轮对话不必为此等待
    prewarmWindowsShell();

    // 渠道注册后由客户端显式启停，消息使用同一套受限的 headless runAgent。
    try {
        const context = {
            runAgent: createChannelRunAgent(registry),
            runtime: buildChannelRuntime(),
            processMessage,
            sleep
        };
        await registerChannels(context, channelPlugins);
    } catch (error) {
        appLog.error('渠道注册失败（不影响其余服务）', { err: error });
    }

    // OAuth 模块需要访问 server 配置（scope 等），注册 resolver 避免循环依赖
    setConfigResolver((name) => {
        const cfg = mcp.getConfigs().find((c) => c.name === name);
        return cfg ? { oauth: cfg.oauth } : undefined;
    });

    // 自动化任务调度器：复用受限 headless runAgent（无人值守安全底线），结果落 conversations。
    // start() 会恢复上次残留的在途任务并排下一次 timer；失败只告警不影响其余服务。
    const dispatchDeps: AutomationDispatchDeps = {
        runAgent: createAutomationRunAgent(registry),
        conversations: getConversationStore()
    };
    const automationScheduler = createScheduler(getAutomationStore(), dispatchDeps);
    try {
        await automationScheduler.start();
    } catch (error) {
        appLog.error('自动化任务调度器启动失败（不影响其余服务）', { err: error });
    }

    // 后台轮次与唤醒：先让 SessionRuntime 能起一轮完整对话，再装 Job/Goal。
    configureBackgroundTurns(() => registry);
    sessionRuntime.setStarter(startBackgroundTurn);

    // 后台任务（P1）：入队 → 受限 headless 执行 → 结果落库 → 完成后唤醒 owner 会话。
    const jobService = createJobService({
        runAgent: createAutomationRunAgent(registry),
        conversations: getConversationStore(),
        emit: (job) => sessionEvents.emit({ type: 'job', job }),
        deliver: (sessionId, text, source) => {
            sessionRuntime.deliver(sessionId, text, source);
        }
    });
    await jobService.recover().catch((err) => appLog.warn('恢复后台任务失败', { err }));
    setJobService(jobService);

    // 自驱循环（P2）：进程本地状态，订阅会话空闲与轮次结束。
    const goalService = new GoalService({
        onIdle: (fn) => sessionRuntime.onIdle(fn),
        onTurnEnd: (fn) =>
            subscribeSessionEvents((event) => {
                if (event.type === 'turn-end') {
                    fn({ sessionId: event.sessionId, source: event.source, outcome: event.outcome });
                }
            }),
        isBusy: (sessionId) => sessionRuntime.isBusy(sessionId),
        deliver: (sessionId, text, source, opts) => sessionRuntime.deliver(sessionId, text, source, opts),
        emit: (goal) => sessionEvents.emit({ type: 'goal', goal }),
        readLastAssistantText: async (sessionId) => {
            const conversation = await getConversationStore().get(sessionId);
            return [...(conversation?.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.content;
        }
    });
    setGoalService(goalService);
    goalService.start();

    runtime.ready = true;
    appLog.info('服务初始化完成（MCP 异步连接中）', { skills: runtime.skills });

    container = { registry, mcp, mcpConfigPath, runtime, automationScheduler, goalService };
    return container;
}

/**
 * 优雅停机：断开所有 MCP 连接（含终止 stdio 子进程，避免残留无窗口的 追寻.exe
 * 让 Windows NSIS 安装器误判应用仍在运行）+ 停止所有渠道监听。
 *
 * 幂等：Electron before-quit 与 standalone 信号兜底可能同时触发，用缓存的 promise 让
 * 重复/并发调用共享同一次清理。逐项 allSettled 并发清理，任一失败不阻断其余；永不抛错。
 */
let shutdownPromise: Promise<void> | undefined;

export async function shutdownServices(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        await Promise.allSettled([
            container?.mcp.disconnectAll() ?? Promise.resolve(),
            channelManager.stopAll(),
            container?.automationScheduler.dispose() ?? Promise.resolve(),
            Promise.resolve(container?.goalService.dispose())
        ]);
    })();
    return shutdownPromise;
}
