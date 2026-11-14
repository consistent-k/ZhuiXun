import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/http/middleware/error-handler';
import { createToolsRouter } from '@/http/routes/tools';
import type { LoadedSkill } from '@/modules/skills';

const loaded: LoadedSkill[] = [
    {
        id: 'demo',
        name: 'Demo',
        description: 'demo skill',
        systemPrompt: 'prompt',
        tools: {},
        toolInfo: [
            { name: 'lookup', description: 'Look up a record' },
            { name: 'no_desc', description: '' }
        ]
    }
];

const registry = {
    loadAll: vi.fn(),
    listLoaded: vi.fn()
} satisfies NonNullable<ReturnType<Parameters<typeof createToolsRouter>[0]>>;

const manager = {
    getConfigs: vi.fn(),
    getConnectedServers: vi.fn(),
    getServerTools: vi.fn()
} satisfies NonNullable<ReturnType<Parameters<typeof createToolsRouter>[1]>>;

let ready = true;
const app = new Hono();
app.route(
    '/',
    createToolsRouter(
        () => (ready ? registry : undefined),
        () => manager
    )
);
app.onError(errorHandler);

async function getLabels(status = 200) {
    const response = await app.request('/api/tools/labels');
    expect(response.status).toBe(status);
    const result = (await response.json()) as { code: number; data?: Record<string, unknown>; message?: string };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result;
}

beforeEach(() => {
    vi.resetAllMocks();
    ready = true;
    registry.loadAll.mockResolvedValue(loaded);
    registry.listLoaded.mockReturnValue(loaded);
    manager.getConfigs.mockReturnValue([
        { name: 'kb-server', transport: 'stdio', disabled: false },
        { name: 'offline-server', transport: 'stdio', disabled: false }
    ]);
    manager.getConnectedServers.mockReturnValue(['kb-server']);
    manager.getServerTools.mockResolvedValue([{ name: 'search', description: 'Search KB' }]);
});

describe('GET /api/tools/labels', () => {
    it('merges skill tools and connected MCP tools into one table', async () => {
        const { data } = await getLabels();
        expect(data).toEqual({
            lookup: { label: 'Look up a record', source: 'local', skillName: 'Demo' },
            // 空 description 回退工具原名，避免前端展示成空白
            no_desc: { label: 'no_desc', source: 'local', skillName: 'Demo' },
            // MCP key 必须是模型实际拿到的 <server>_<tool> 前缀名，`-` 清洗为 `_`
            kb_server_search: { label: 'Search KB', source: 'mcp', skillName: 'kb-server' }
        });
        // 只问已连接的 server，未连接的不多打一次 RPC
        expect(manager.getServerTools).toHaveBeenCalledTimes(1);
        expect(manager.getServerTools).toHaveBeenCalledWith('kb-server');
    });

    it('reports 503 until the skill registry is initialized', async () => {
        ready = false;
        await getLabels(503);
    });

    it('degrades to MCP-only labels when loadAll fails', async () => {
        registry.loadAll.mockRejectedValue(new Error('boom'));
        registry.listLoaded.mockReturnValue([]);
        const { data } = await getLabels();
        expect(data).toHaveProperty('kb_server_search');
        expect(data).not.toHaveProperty('lookup');
    });

    it('skips a failing server instead of failing the whole response', async () => {
        manager.getServerTools.mockRejectedValue(new Error('listTools failed'));
        const { data } = await getLabels();
        expect(data).toHaveProperty('lookup');
        expect(data).not.toHaveProperty('kb_server_search');
    });

    it('keeps skill labels when an MCP tool name collides', async () => {
        manager.getServerTools.mockResolvedValue([{ name: 'lookup', description: 'MCP lookup' }]);
        const { data } = await getLabels();
        expect(data.lookup).toEqual({ label: 'Look up a record', source: 'local', skillName: 'Demo' });
    });
});
