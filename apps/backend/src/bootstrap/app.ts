import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { apiGuard, corsOriginResolver } from '@/http/middleware/auth';
import { errorHandler, notFoundHandler } from '@/http/middleware/error-handler';
import { httpLogger } from '@/http/middleware/request-logger';
import {
    createAutomationRouter,
    createChannelsRouter,
    createChatRouter,
    createCommandsRouter,
    createConversationsRouter,
    createConnectorsRouter,
    createDebugRouter,
    createGoalRouter,
    createHealthRouter,
    createHooksRouter,
    createJobsRouter,
    createLogsRouter,
    createMCPRouter,
    createMemoryRouter,
    createPermissionRouter,
    createPersonaRouter,
    createProjectsRouter,
    createSessionRouter,
    createSkillHubRouter,
    createSkillsRouter,
    createToolsRouter,
    createWorkspaceRouter,
    settingsRouter
} from '@/http/routes';
import { hooksView } from '@/modules/hooks';
import { loadBaseline } from '@/modules/permission';

import { getContainer, type ServiceContainer } from './services';

/** /health 附加的安全态势：权限团队基线来源（内置 / 外部 / 损坏）与 hooks 状态。 */
async function securityPosture(): Promise<Record<string, unknown>> {
    const baseline = await loadBaseline();
    return { permissionBaseline: baseline.source, hooks: hooksView().status };
}

/**
 * HTTP 组合根：只挂中间件与路由，不承载初始化逻辑、不持有服务状态。
 * 所有依赖经 getter 惰性读取——服务在 `startServer` 中异步初始化，
 * 构造路由时它还不存在，因此不能用立即求值。测试可注入独立容器 getter。
 */
export function createApp(getServices: () => ServiceContainer | undefined = getContainer): Hono {
    const app = new Hono();

    app.use('*', httpLogger);
    // CORS 收敛为白名单来源（Electron 渲染进程 + 本地 dev 前端），不再对任意站点下发 ACAO。
    app.use('*', cors({ origin: corsOriginResolver, credentials: true }));
    // /api/* 统一走访问闸（Origin 白名单 + 可选共享 token）。health 在 /health 不受影响。
    app.use('/api/*', apiGuard);

    app.route(
        '/',
        createHealthRouter(() => getServices()?.runtime, securityPosture)
    );
    app.route('/', settingsRouter);
    app.route('/', createWorkspaceRouter());

    // 调试端点（技能/工具清单）
    app.route(
        '/',
        createDebugRouter(() => getServices()?.registry)
    );

    // 对话：唯一实现收口在 routes/chat/index.ts；编排在 modules/chat/service.ts。
    app.route(
        '/',
        createChatRouter(() => getServices()?.registry)
    );

    // 技能列表：唯一实现收口在 routes/skills/index.ts
    app.route(
        '/',
        createSkillsRouter(() => getServices()?.registry)
    );

    // SkillHub 技能广场：搜索 / 详情 / 下载安装 / 配置
    app.route(
        '/',
        createSkillHubRouter(() => getServices()?.registry)
    );

    // MCP 服务器管理 CRUD
    app.route(
        '/',
        createMCPRouter(
            () => getServices()?.mcp,
            () => getServices()?.mcpConfigPath ?? ''
        )
    );

    app.route(
        '/',
        createConnectorsRouter(
            () => getServices()?.mcp,
            () => getServices()?.mcpConfigPath ?? ''
        )
    );

    // 工具标签：技能工具 + 已连接 MCP 工具合并成「工具名 → 标签」一次下发（前端单个请求查表）
    app.route(
        '/',
        createToolsRouter(
            () => getServices()?.registry,
            () => getServices()?.mcp
        )
    );

    // 记忆管理 CRUD（后端拥有记忆，落盘为 Markdown；模型侧通过 memory-tools 读写同一 store）
    app.route('/', createMemoryRouter());

    // 智能体风格：内置/自定义表达风格 + 默认选择
    app.route('/', createPersonaRouter());

    // 命令审批权限 CRUD（Bash 免重复确认：永久规则落盘 + 会话内存，审批网关读同一 store）
    app.route('/', createPermissionRouter());
    app.route('/', createHooksRouter());
    // slash 命令宏 CRUD 与展开
    app.route('/', createCommandsRouter());

    // 会话管理 CRUD（会话真源在后端 ~/.zhuixun/sessions/，每会话一文件 + index.json）
    app.route('/', createConversationsRouter());

    // 项目管理 CRUD（项目真源在后端 ~/.zhuixun/projects/<id>/，逻辑分组、不绑定目录）
    app.route('/', createProjectsRouter());

    // 渠道（IM 接入）控制面 + 事件 SSE
    app.route('/', createChannelsRouter());

    // 自动化任务（定时触发）CRUD + 运行历史 + 事件 SSE
    app.route('/', createAutomationRouter());

    // 后台任务（手动触发的长跑）列表/取消 + 自驱循环状态/解除
    app.route('/', createJobsRouter());
    app.route('/', createGoalRouter());

    // 会话运行事件 SSE（后台完成唤醒 / 自驱轮次 / Job 状态）
    app.route('/', createSessionRouter());

    // 日志查看 / 导出（设置页「日志」面板）
    app.route('/', createLogsRouter());

    app.notFound(notFoundHandler);
    app.onError(errorHandler);
    return app;
}

export default createApp();
