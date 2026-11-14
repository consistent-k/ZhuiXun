import type { ToolLabelItem } from '@zhuixun/shared';
import { Hono } from 'hono';

import type { MCPClientManager } from '@/modules/mcp';
import type { SkillRegistry } from '@/modules/skills';
import { createLogger } from '@/platform/logging/index';
import { buildPrefixedToolName } from '@/platform/tool-naming';

const log = createLogger('Tools');

// 只声明本路由消费的能力，测试无需伪造完整 registry / manager。
type ToolsRouteRegistry = Pick<SkillRegistry, 'loadAll' | 'listLoaded'>;
type ToolsRouteManager = Pick<MCPClientManager, 'getConfigs' | 'getConnectedServers' | 'getServerTools'>;

/**
 * 工具标签接口。
 *
 * GET /api/tools/labels —— 一次返回「工具名 → 标签」全量映射，合并技能工具与已连接 MCP 工具。
 *
 * 背景：前端活动流/审批卡要把工具名显示成人话，原先需要自己打 1 + 1 + N 个请求
 * （`/api/skills` + `/api/mcp/servers` + 每个 server 一个 `/tools`）。请求数随 MCP server 数量
 * 线性增长，且 `/api/mcp/servers` 内部为统计 toolCount 还会再 listTools 一遍，等于同一批工具
 * 被拉两次。这里把 fan-out 收到后端一次完成，前端只发一个请求。
 *
 * key 的形态必须是模型实际拿到的工具名：技能工具是原始名，MCP 工具是 `buildPrefixedToolName`
 * 拼出的 `<sanitizedServer>_<sanitizedTool>`，与 runner 注册给模型的 schema 完全一致，
 * 否则前端查表会落空（展示退化成工具原名）。
 *
 * 技能工具优先写入、MCP 不覆盖同名项，与前端原有「先技能后 MCP」的合并顺序一致。
 */
export function createToolsRouter(
    getRegistry: () => ToolsRouteRegistry | undefined,
    getManager: () => ToolsRouteManager | undefined
) {
    const tools = new Hono();

    tools.get('/api/tools/labels', async (c) => {
        const registry = getRegistry();
        if (!registry) {
            return c.json({ code: 503, message: '服务尚未就绪（技能注册表未初始化）' }, 503);
        }

        const labels: Record<string, ToolLabelItem> = {};

        // 技能工具：工具信息要等技能完整加载后才有，首次请求触发加载，之后走缓存
        try {
            await registry.loadAll();
        } catch (error) {
            log.error('loadAll 失败，工具标签降级为仅返回已加载技能与 MCP', { err: error });
        }
        for (const skill of registry.listLoaded()) {
            for (const tool of skill.toolInfo) {
                if (tool.name in labels) continue;
                labels[tool.name] = {
                    label: tool.description || tool.name,
                    source: 'local',
                    skillName: skill.name
                };
            }
        }

        // MCP 工具：只问已连接的 server（未连接时 getServerTools 恒为空，白白多打一次 RPC）
        const manager = getManager();
        const connected = new Set(manager?.getConnectedServers() ?? []);
        const settled = manager
            ? await Promise.allSettled(
                  manager
                      .getConfigs()
                      .filter((cfg) => connected.has(cfg.name))
                      .map(async (cfg) => ({ name: cfg.name, tools: await manager.getServerTools(cfg.name) }))
              )
            : [];
        for (const result of settled) {
            if (result.status !== 'fulfilled') continue;
            const { name, tools: serverTools } = result.value;
            for (const tool of serverTools) {
                const key = buildPrefixedToolName(name, tool.name);
                if (key in labels) continue;
                labels[key] = {
                    label: tool.description || tool.name,
                    source: 'mcp',
                    skillName: name
                };
            }
        }

        return c.json({ code: 0, data: labels });
    });

    return tools;
}
