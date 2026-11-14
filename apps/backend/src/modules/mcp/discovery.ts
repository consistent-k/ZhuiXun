import { createLogger } from '@/platform/logging/index';

import type { MCPToolAdapter } from './adapter';
import { type MCPToolInfo } from './adapter';

const log = createLogger('MCPDiscovery');

/** 通用分词：驼峰拆分 + 按非字母数字（保留 CJK）切，小写、去重前的 token 列表（长度 ≥ 2） */
function tokenize(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^\p{L}\p{N}]+/u)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length >= 2);
}

/** 单个 query 词在某字段上的得分：精确 token > 前缀 > 子串，权重随 base 缩放 */
function fieldScore(word: string, tokens: Set<string>, raw: string, base: number): number {
    if (tokens.has(word)) return base;
    if ([...tokens].some((t) => t.startsWith(word) || word.startsWith(t))) return base * 0.6;
    if (raw.includes(word)) return base * 0.3;
    return 0;
}

/**
 * MCP 工具发现类
 * 提供工具搜索和按需加载功能
 */
export class MCPToolDiscovery {
    private toolsCache: MCPToolInfo[] | null = null;
    private lastCacheTime = 0;
    private cacheTTL = 30000; // 30秒缓存
    private refreshPromise: Promise<void> | null = null;

    constructor(private adapter: MCPToolAdapter) {}

    /** 刷新工具缓存 */
    async refreshCache(): Promise<void> {
        this.toolsCache = await this.adapter.getAllToolsInfo();
        this.lastCacheTime = Date.now();
        log.info('刷新工具缓存', { count: this.toolsCache.length });
    }

    /** 获取所有工具信息（带缓存，并发 miss 时只触发一次刷新） */
    async getAllTools(): Promise<MCPToolInfo[]> {
        if (!this.toolsCache || Date.now() - this.lastCacheTime > this.cacheTTL) {
            if (!this.refreshPromise) {
                this.refreshPromise = this.refreshCache().finally(() => {
                    this.refreshPromise = null;
                });
            }
            await this.refreshPromise;
        }
        return this.toolsCache || [];
    }

    /**
     * 搜索工具：通用相关性打分（无任何领域硬编码词表）。
     *
     * 打分维度：整串精确/包含匹配给高权重；再对 query 分词后，逐词在
     * name（权重最高）/ description / server / tags 上做「精确 token > 前缀 > 子串」
     * 的递减加权累计，最后按分数降序。空 query 返回全部（按 server/name 稳定排序）。
     *
     * @param query 自然语言查询
     * @param server 可选，限定服务器
     * @param limit 返回条数上限（默认 10）
     */
    async searchTools(query: string, server?: string, limit = 10): Promise<MCPToolInfo[]> {
        const allTools = await this.getAllTools();
        const filtered = server ? allTools.filter((t) => t.server === server) : allTools;

        const q = query.trim().toLowerCase();
        // 空 query：返回全部，稳定排序（server 再 name），便于「列出全部」语义
        if (!q) {
            return [...filtered]
                .sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
                .slice(0, limit);
        }

        const queryTokens = tokenize(q);

        const scored = filtered.map((tool) => {
            const nameLower = tool.name.toLowerCase();
            const descLower = tool.description.toLowerCase();
            const serverLower = tool.server.toLowerCase();
            let score = 0;

            // 整串匹配
            if (nameLower === q) score += 100;
            else if (nameLower.includes(q)) score += 40;
            if (descLower.includes(q)) score += 20;

            // 分词字段加权
            const nameTokens = new Set(tokenize(nameLower));
            const descTokens = new Set(tokenize(descLower));
            const serverTokens = new Set(tokenize(serverLower));
            const tagSet = new Set(tool.tags.map((t) => t.toLowerCase()));

            for (const w of queryTokens) {
                score += fieldScore(w, nameTokens, nameLower, 12);
                score += fieldScore(w, descTokens, descLower, 5);
                score += fieldScore(w, serverTokens, serverLower, 4);
                if (tagSet.has(w)) score += 6;
            }

            return { tool, score };
        });

        return scored
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
            .slice(0, limit)
            .map((item) => item.tool);
    }

    /**
     * 根据工具名获取工具信息
     * @param toolName 工具名称
     * @param server 可选，指定服务器名称
     * @returns 工具信息或 undefined
     */
    async getToolByName(toolName: string, server?: string): Promise<MCPToolInfo | undefined> {
        const allTools = await this.getAllTools();

        return allTools.find((t) => {
            const nameMatch = t.name === toolName;
            const serverMatch = server ? t.server === server : true;
            return nameMatch && serverMatch;
        });
    }

    /**
     * 获取指定服务器的所有工具
     * @param server 服务器名称
     * @returns 工具列表
     */
    async getToolsByServer(server: string): Promise<MCPToolInfo[]> {
        const allTools = await this.getAllTools();
        return allTools.filter((t) => t.server === server);
    }

    /**
     * 获取所有可用的服务器列表
     * @returns 服务器名称数组
     */
    async getAvailableServers(): Promise<string[]> {
        const allTools = await this.getAllTools();
        const servers = new Set(allTools.map((t) => t.server));
        return Array.from(servers);
    }

    /**
     * 格式化工具列表为可读文本
     * @param tools 工具列表
     * @returns 格式化后的文本
     */
    formatToolsList(tools: MCPToolInfo[]): string {
        if (tools.length === 0) {
            return '未找到匹配的工具';
        }

        const lines = tools.map((tool, index) => {
            return `${index + 1}. **${tool.name}** (${tool.server})\n   ${tool.description}`;
        });

        return lines.join('\n\n');
    }
}
