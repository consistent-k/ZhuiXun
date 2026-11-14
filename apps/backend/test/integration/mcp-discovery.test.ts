import { createMCPClient, type JSONRPCMessage, type MCPClient, type MCPTransport } from '@ai-sdk/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MCPToolAdapter } from '@/modules/mcp/adapter';
import { MCPToolDiscovery } from '@/modules/mcp/discovery';

// 只替换传输边界：initialize/listTools/callTool 均经 SDK 真正的 JSON-RPC 编解码，绝不监听端口。
class MemoryTransport implements MCPTransport {
    onmessage?: (message: JSONRPCMessage) => void;
    onclose?: () => void;
    calls: JSONRPCMessage[] = [];
    failList = false;
    definitions = [
        {
            name: 'read_record',
            description: 'Read project record',
            inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } } }
        },
        {
            name: 'record_summary',
            description: 'Summarize docs information',
            inputSchema: { type: 'object' as const }
        },
        { name: 'browse_files', description: 'Browse filesystem', inputSchema: { type: 'object' as const } },
        { name: 'docsSearch', description: '检索项目资料', inputSchema: { type: 'object' as const } }
    ];
    async start() {}
    async close() {
        this.onclose?.();
    }
    async send(message: JSONRPCMessage) {
        this.calls.push(message);
        if (!('method' in message) || !('id' in message)) return;
        if (message.method === 'tools/list' && this.failList) {
            this.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32603, message: 'fixture listing failed' }
            });
            return;
        }
        const result =
            message.method === 'initialize'
                ? {
                      protocolVersion: '2025-06-18',
                      capabilities: { tools: {} },
                      serverInfo: { name: 'memory-fixture', version: '1.0' }
                  }
                : message.method === 'tools/list'
                  ? { tools: this.definitions }
                  : { content: [{ type: 'text', text: JSON.stringify(message.params) }] };
        this.onmessage?.({ jsonrpc: '2.0', id: message.id, result });
    }
    count(method: string) {
        return this.calls.filter((call) => 'method' in call && call.method === method).length;
    }
}

const clients: MCPClient[] = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const connected of clients.splice(0)) await connected.close();
});

async function fixture() {
    const transport = new MemoryTransport();
    const connected = await createMCPClient({ transport });
    clients.push(connected);
    const active = new Map([['docs', connected]]);
    const adapter = new MCPToolAdapter({
        getClient: (name) => active.get(name),
        getConnectedServers: () => [...active.keys()]
    });
    return { transport, connected, active, adapter, discovery: new MCPToolDiscovery(adapter) };
}

describe('Discovery with real SDK tools, real adapter and memory transport', () => {
    it('discovers metadata and executes SDK-generated cached tools through the actual adapter', async () => {
        const { transport, adapter, discovery } = await fixture();
        expect(transport.count('initialize')).toBe(1);
        const found = await discovery.getToolByName('read_record', 'docs');
        expect(found).toMatchObject({ name: 'read_record', server: 'docs', tags: ['read', 'record', 'project'] });
        const loaded = await adapter.getTool(found!.server, found!.name);
        const result = await loaded!.execute!(
            { id: 'fixture-id' },
            { toolCallId: 'fixture-call', messages: [], context: {} }
        );
        expect(result).toMatchObject({
            content: [{ type: 'text', text: JSON.stringify({ name: 'read_record', arguments: { id: 'fixture-id' } }) }]
        });
        expect(transport.count('tools/call')).toBe(1);
        expect(await adapter.getTool('docs', 'read_record')).toBe(loaded);
        expect(transport.count('tools/list')).toBe(2); // metadata + SDK tools，各自仅加载一次
        expect(await discovery.getToolByName('read_record', 'other')).toBeUndefined();
        expect(await discovery.getToolByName('missing')).toBeUndefined();
        expect((await discovery.getToolsByServer('docs')).length).toBe(4);
        expect(await discovery.getToolsByServer('missing')).toEqual([]);
        expect(await discovery.getAvailableServers()).toEqual(['docs']);
    });

    it('coalesces simultaneous cache misses, caches at TTL boundary, refreshes after TTL and permits explicit refresh', async () => {
        const { transport, discovery } = await fixture();
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const [a, b, c] = await Promise.all([
            discovery.getAllTools(),
            discovery.getAllTools(),
            discovery.getAllTools()
        ]);
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(transport.count('tools/list')).toBe(1);
        transport.definitions = [transport.definitions[0]];
        vi.advanceTimersByTime(30_000);
        expect(await discovery.getAllTools()).toBe(a);
        vi.advanceTimersByTime(1);
        expect((await discovery.getAllTools()).map((tool) => tool.name)).toEqual(['read_record']);
        expect(transport.count('tools/list')).toBe(2);
        transport.definitions = [];
        await discovery.refreshCache();
        expect(await discovery.getAllTools()).toEqual([]);
        expect(transport.count('tools/list')).toBe(3);
    });

    it('ranks exact names ahead of substring/description/server/tag matches with stable filtering and limits', async () => {
        const { discovery, transport } = await fixture();
        transport.definitions.push(
            { name: 'zeta', description: 'record in description', inputSchema: { type: 'object' } },
            { name: 'alpha', description: 'record in description', inputSchema: { type: 'object' } }
        );
        expect((await discovery.searchTools('read_record')).map((tool) => tool.name)).toEqual([
            'read_record',
            'record_summary',
            'alpha',
            'zeta'
        ]);
        expect((await discovery.searchTools('record')).map((tool) => tool.name)).toEqual([
            'read_record',
            'record_summary',
            'alpha',
            'zeta'
        ]);
        expect((await discovery.searchTools('record', 'docs', 2)).map((tool) => tool.name)).toEqual([
            'read_record',
            'record_summary'
        ]);
        expect(await discovery.searchTools('record', 'missing')).toEqual([]);
        expect(await discovery.searchTools('unmatched')).toEqual([]);
        expect(await discovery.searchTools('record', undefined, 0)).toEqual([]);
        expect((await discovery.searchTools('  READ_RECORD  ')).map((tool) => tool.name)).toEqual([
            'read_record',
            'record_summary',
            'alpha',
            'zeta'
        ]);
        expect((await discovery.searchTools('rec')).map((tool) => tool.name)).toEqual([
            'read_record',
            'record_summary',
            'alpha',
            'zeta'
        ]);
        expect((await discovery.searchTools('cord')).map((tool) => tool.name)).toEqual([
            'read_record',
            'record_summary',
            'alpha',
            'zeta'
        ]);
        expect((await discovery.searchTools('docs')).map((tool) => tool.name)).toEqual([
            'docsSearch',
            'record_summary',
            'alpha',
            'browse_files',
            'read_record',
            'zeta'
        ]);
        expect((await discovery.searchTools('项目')).map((tool) => tool.name)).toEqual(['docsSearch']);
        expect((await discovery.searchTools(' ')).map((tool) => tool.name)).toEqual([
            'alpha',
            'browse_files',
            'docsSearch',
            'read_record',
            'record_summary',
            'zeta'
        ]);
    });

    it('sorts empty queries by server before tool name, deduplicates servers and formats results without mutating cache', async () => {
        const { discovery, active, connected } = await fixture();
        active.set('aaa', connected);
        const all = await discovery.getAllTools();
        expect((await discovery.searchTools('', undefined, 5)).map((tool) => `${tool.server}/${tool.name}`)).toEqual([
            'aaa/browse_files',
            'aaa/docsSearch',
            'aaa/read_record',
            'aaa/record_summary',
            'docs/browse_files'
        ]);
        expect(await discovery.getAvailableServers()).toEqual(['docs', 'aaa']);
        expect(all[0].name).toBe('read_record');
        expect(discovery.formatToolsList([])).toBe('未找到匹配的工具');
        expect(discovery.formatToolsList(all.slice(0, 2))).toBe(
            '1. **read_record** (docs)\n   Read project record\n\n2. **record_summary** (docs)\n   Summarize docs information'
        );
    });

    it('survives protocol list errors and recovers with a subsequent explicit refresh', async () => {
        const { transport, discovery } = await fixture();
        transport.failList = true;
        expect(await discovery.getAllTools()).toEqual([]);
        expect(await discovery.getAvailableServers()).toEqual([]);
        transport.failList = false;
        await discovery.refreshCache();
        expect((await discovery.searchTools('read')).map((tool) => tool.name)).toEqual(['read_record']);
        expect(transport.count('tools/list')).toBe(2);
    });
});
