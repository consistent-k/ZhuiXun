import os from 'node:os';
import path from 'node:path';

import { jsonSchema, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MCPClientManager, MCPToolAdapter, MCPToolDiscovery } from '@/modules/mcp';

const sdk = vi.hoisted(() => ({ create: vi.fn(), transport: vi.fn() }));
vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: sdk.create }));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: sdk.transport }));

let manager: MCPClientManager | undefined;
afterEach(async () => {
    await manager?.disconnectAll();
    vi.useRealTimers();
    vi.resetAllMocks();
});

describe('manager → adapter → discovery lifecycle', () => {
    it('executes loaded tools and invalidates captured client closures on manager reconnect', async () => {
        expect(os.homedir()).toBe(process.env.ZHUIXUN_TEST_HOME);
        expect(process.env.MCP_OAUTH_PATH).toBe(path.join(os.homedir(), 'mcp-oauth.json'));
        const generations: Array<{
            close: ReturnType<typeof vi.fn>;
            tools: ReturnType<typeof vi.fn>;
            listTools: ReturnType<typeof vi.fn>;
            execute: ReturnType<typeof vi.fn>;
        }> = [];
        sdk.transport.mockImplementation(function (url) {
            return { url };
        });
        sdk.create.mockImplementation(async () => {
            const generation = generations.length + 1;
            const execute = vi.fn(async ({ value }: { value: string }) => ({ generation, value }));
            const c = {
                close: vi.fn().mockResolvedValue(undefined),
                execute,
                listTools: vi.fn().mockResolvedValue({
                    tools: [
                        {
                            name: 'fixture_lookup',
                            description: 'Offline fixture lookup',
                            inputSchema: { type: 'object' }
                        }
                    ]
                }),
                tools: vi.fn().mockResolvedValue({
                    fixture_lookup: tool({
                        description: 'Offline fixture lookup',
                        inputSchema: jsonSchema<{ value: string }>({
                            type: 'object',
                            properties: { value: { type: 'string' } }
                        }),
                        execute
                    })
                })
            };
            generations.push(c);
            return c;
        });
        manager = new MCPClientManager([{ name: 'fixture', transport: 'sse', url: 'https://fixture.invalid/mcp' }]);
        const adapter = new MCPToolAdapter(manager);
        const discovery = new MCPToolDiscovery(adapter);
        expect(await manager.connectAll()).toEqual([{ name: 'fixture', ok: true }]);
        expect(await discovery.searchTools('lookup')).toMatchObject([{ name: 'fixture_lookup', server: 'fixture' }]);
        const first = await adapter.getTool('fixture', 'fixture_lookup');
        expect(first?.execute).toBeTypeOf('function');
        const options = { toolCallId: 'fixture-call', messages: [], context: {} };
        expect(await first!.execute!({ value: 'first' }, options)).toEqual({ generation: 1, value: 'first' });
        expect(await adapter.getTool('fixture', 'fixture_lookup')).toBe(first);
        expect(generations[0].tools).toHaveBeenCalledOnce();
        expect(await manager.reconnectServer('fixture')).toEqual({ name: 'fixture', ok: true });
        expect(generations[0].close).toHaveBeenCalledOnce();
        const second = await adapter.getTool('fixture', 'fixture_lookup');
        expect(second).not.toBe(first);
        expect(await second!.execute!({ value: 'second' }, options)).toEqual({ generation: 2, value: 'second' });
        expect(generations[0].execute).toHaveBeenCalledTimes(1);
        expect(generations[1].tools).toHaveBeenCalledOnce();
        const all = await adapter.getAllTools();
        expect(Object.keys(all)).toEqual(['fixture_fixture_lookup']);
        await manager.removeServer('fixture');
        expect(await adapter.getTool('fixture', 'fixture_lookup')).toBeNull();
        expect(await adapter.getAllTools()).toEqual({});
        // 发现层元数据是30秒快照；显式刷新才反映移除，避免假装它与manager实时同步。
        expect(await discovery.getAvailableServers()).toEqual(['fixture']);
        await discovery.refreshCache();
        expect(await discovery.getAllTools()).toEqual([]);
        expect(generations[1].close).toHaveBeenCalledOnce();
    });
});
