import type { Tool, ToolExecutionOptions, ToolSet } from 'ai';

import { createLogger } from '@/platform/logging/index';
import { buildPrefixedToolName } from '@/platform/tool-naming';

import type { MCPClient } from './manager';

const log = createLogger('MCP');

// 仅依赖实际消费的客户端能力，避免适配层绑定管理器的连接/进程生命周期；
// 生产 manager 结构兼容，测试可提供纯内存客户端而无需启动真实 transport。
type ToolClient = {
    tools(): Promise<ToolSet>;
    listTools: MCPClient['listTools'];
};
export interface MCPToolSource {
    getClient(serverName: string): ToolClient | undefined;
    getConnectedServers(): string[];
}

/** MCP 工具元信息 */
export interface MCPToolInfo {
    name: string;
    displayName: string;
    description: string;
    server: string;
    inputSchema: unknown;
    tags: string[];
}

/**
 * MCP → AI SDK 工具适配器。
 *
 * 工具的 schema 转换与 execute 封装由 `@ai-sdk/mcp` 的 `client.tools()` 原生完成
 * （schema discovery），不再手写 JSON-Schema→zod。本类只在其之上补两件事：
 * 1. 按 server 缓存已转换的工具，并在底层 client 实例变化（重连）时失效——
 *    SDK 生成的工具闭包捕获具体 client 实例，重连后旧实例已关闭，必须丢弃重取；
 * 2. 用防御性包装包住 execute：工具调用抛错时返回 `{success,error}` 而非 throw。
 *    直接 throw 会让 AI SDK 尝试把（可能含循环引用、不可序列化的）MCP 协议错误
 *    转成模型可读的 tool result，序列化失败会中断整个 stream，而不止这一次调用。
 */
export class MCPToolAdapter {
    /** server → { 生成这批工具时的 client 实例, 已转换并包装的工具集 } */
    private cache = new Map<string, { client: ToolClient; tools: ToolSet }>();

    constructor(private manager: MCPToolSource) {}

    /** 用防御性 try/catch 包住每个工具的 execute（见类注释），其余字段原样透传 */
    private wrap(serverName: string, raw: ToolSet): ToolSet {
        const wrapped: ToolSet = {};
        for (const [name, mcpTool] of Object.entries(raw)) {
            const original = (mcpTool as Tool).execute;
            if (!original) {
                wrapped[name] = mcpTool;
                continue;
            }
            wrapped[name] = {
                ...mcpTool,
                execute: async (input: unknown, options: ToolExecutionOptions<unknown>) => {
                    const start = Date.now();
                    log.info('调用工具', {
                        server: serverName,
                        tool: name,
                        params: JSON.stringify(input).slice(0, 200)
                    });
                    try {
                        const result = await original(input as never, options);
                        log.info('工具调用完成', { server: serverName, tool: name, durationMs: Date.now() - start });
                        return result;
                    } catch (error) {
                        log.error('工具调用失败', { server: serverName, tool: name, err: error });
                        return {
                            success: false,
                            error: error instanceof Error ? error.message : String(error)
                        };
                    }
                }
            } as Tool;
        }
        return wrapped;
    }

    /** 获取指定服务器的所有工具（AI SDK 格式，未加 server 前缀）；按 client 实例缓存 */
    async getToolsForServer(serverName: string): Promise<ToolSet> {
        const client = this.manager.getClient(serverName);
        if (!client) {
            log.warn('服务未连接', { server: serverName });
            return {};
        }

        const cached = this.cache.get(serverName);
        if (cached && cached.client === client) return cached.tools;

        try {
            // SDK 原生做 listTools + schema 转换；用显式 schemas 省略以走自动发现
            const raw = (await client.tools()) as ToolSet;
            const tools = this.wrap(serverName, raw);
            this.cache.set(serverName, { client, tools });
            log.info('已加载工具', { server: serverName, count: Object.keys(tools).length });
            return tools;
        } catch (error) {
            log.error('列出工具失败', { server: serverName, err: error });
            return {};
        }
    }

    /** 获取单个工具（渐进式加载按需调用）；不存在返回 null */
    async getTool(serverName: string, mcpToolName: string): Promise<Tool | null> {
        const tools = await this.getToolsForServer(serverName);
        return (tools[mcpToolName] as Tool) ?? null;
    }

    /** 获取所有服务器的所有工具（加 server 前缀，避免跨 server 工具名冲突） */
    async getAllTools(): Promise<ToolSet> {
        const allTools: ToolSet = {};
        for (const serverName of this.manager.getConnectedServers()) {
            const serverTools = await this.getToolsForServer(serverName);
            for (const [toolName, toolImpl] of Object.entries(serverTools)) {
                allTools[buildPrefixedToolName(serverName, toolName)] = toolImpl;
            }
        }
        log.info('已加载全部 MCP 工具', { count: Object.keys(allTools).length });
        return allTools;
    }

    /** 获取所有 MCP 工具的元信息（用于搜索，走原始 listTools 元数据，不做 schema 转换） */
    async getAllToolsInfo(): Promise<MCPToolInfo[]> {
        const toolsInfo: MCPToolInfo[] = [];
        for (const serverName of this.manager.getConnectedServers()) {
            const client = this.manager.getClient(serverName);
            if (!client) continue;

            try {
                const result = await client.listTools();
                for (const mcpTool of result.tools) {
                    toolsInfo.push({
                        name: mcpTool.name,
                        displayName: mcpTool.name.replace(/_/g, ' '),
                        description: mcpTool.description || mcpTool.name,
                        server: serverName,
                        inputSchema: mcpTool.inputSchema,
                        tags: this.extractTags(mcpTool.name, mcpTool.description || '')
                    });
                }
            } catch (error) {
                log.error('列出工具失败', { server: serverName, err: error });
            }
        }
        return toolsInfo;
    }

    /**
     * 从工具名/描述里提取通用关键词标签(不含任何领域硬编码词表)。
     * 规则：按下划线/连字符/驼峰/非字母数字切词，取长度 ≥ 2 的去重 token(上限 8 个)，
     * 让搜索对任意领域的 MCP server 都能泛化。
     */
    private extractTags(toolName: string, description = ''): string[] {
        const source = `${toolName} ${description}`;
        const tokens = source
            // 驼峰拆分
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            // 非字母数字（含 CJK 保留）切分
            .split(/[^\p{L}\p{N}]+/u)
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length >= 2);
        return Array.from(new Set(tokens)).slice(0, 8);
    }
}
