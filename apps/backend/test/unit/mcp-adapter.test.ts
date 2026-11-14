import type { ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { MCPToolAdapter, type MCPToolSource } from '@/modules/mcp/adapter';

const schema = jsonSchema<{ value: string }>({
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value']
});
const options = { toolCallId: 'fixture-call', messages: [], context: {} };
type Client = NonNullable<ReturnType<MCPToolSource['getClient']>>;

function source(clients: Map<string, Client>, names = [...clients.keys()]): MCPToolSource {
    return { getClient: (name) => clients.get(name), getConnectedServers: () => names };
}

function client(raw: ToolSet): Client {
    return { tools: vi.fn(async () => raw), listTools: vi.fn(async () => ({ tools: [] })) };
}

describe('MCPToolAdapter actual execute wrapper and client identity cache', () => {
    it('passes input/options/output and schema unchanged; tools without execute pass through', async () => {
        const execute = vi.fn(async (input: { value: string }) => ({ received: input.value }));
        const promptOnly = tool({ inputSchema: schema, description: 'no execute' });
        const raw = { echo: tool({ inputSchema: schema, description: 'echo description', execute }), promptOnly };
        const connected = client(raw);
        const adapter = new MCPToolAdapter(source(new Map([['fixture', connected]])));
        const tools = await adapter.getToolsForServer('fixture');
        expect(tools.echo.inputSchema).toBe(raw.echo.inputSchema);
        expect(tools.echo.description).toBe('echo description');
        expect(tools.promptOnly).toBe(promptOnly);
        const input = { value: 'fixture-input' };
        expect(await tools.echo.execute!(input, options)).toEqual({ received: 'fixture-input' });
        expect(execute).toHaveBeenCalledWith(input, options);
        expect(await adapter.getToolsForServer('fixture')).toBe(tools);
        expect(await adapter.getTool('fixture', 'echo')).toBe(tools.echo);
        expect(await adapter.getTool('fixture', 'absent')).toBeNull();
        expect(connected.tools).toHaveBeenCalledTimes(1);
    });

    it('returns serializable results for Error, circular Error, string and null rejections', async () => {
        const circular = new Error('cyclic protocol failure');
        circular.cause = circular;
        for (const [failure, message] of [
            [new Error('failed'), 'failed'],
            [circular, 'cyclic protocol failure'],
            ['string failure', 'string failure'],
            [null, 'null']
        ] as const) {
            const connected = client({
                fail: tool({
                    inputSchema: schema,
                    execute: async (): Promise<string> => {
                        throw failure;
                    }
                })
            });
            const adapter = new MCPToolAdapter(source(new Map([['fixture', connected]])));
            const loaded = await adapter.getTool('fixture', 'fail');
            const result = await loaded!.execute!({ value: 'fixture' }, options);
            expect(result).toEqual({ success: false, error: message });
            expect(JSON.stringify(result)).toBe(JSON.stringify({ success: false, error: message }));
        }
    });

    it('does not serve disconnected cache, invalidates on reconnection and prefixes collisions', async () => {
        const first = client({ 'same.tool': tool({ inputSchema: schema, execute: async () => 'first-client' }) });
        const second = client({ 'same.tool': tool({ inputSchema: schema, execute: async () => 'second-client' }) });
        const other = client({ 'same.tool': tool({ inputSchema: schema, execute: async () => 'other-server' }) });
        const clients = new Map([
            ['my-server', first],
            ['other server', other]
        ]);
        const adapter = new MCPToolAdapter(source(clients));
        const original = await adapter.getToolsForServer('my-server');
        clients.delete('my-server');
        expect(await adapter.getToolsForServer('my-server')).toEqual({});
        clients.set('my-server', second);
        const reconnected = await adapter.getToolsForServer('my-server');
        expect(reconnected).not.toBe(original);
        expect(await reconnected['same.tool'].execute!({}, options)).toBe('second-client');
        expect(first.tools).toHaveBeenCalledTimes(1);
        expect(second.tools).toHaveBeenCalledTimes(1);
        const all = await adapter.getAllTools();
        expect(Object.keys(all).sort()).toEqual(['my_server_same_tool', 'other_server_same_tool']);
        expect(await all.other_server_same_tool.execute!({}, options)).toBe('other-server');
    });

    it('does not cache failed discovery and retries next request; empty source stays empty', async () => {
        const connected = client({ ok: tool({ inputSchema: schema }) });
        vi.mocked(connected.tools).mockRejectedValueOnce(new Error('list failure'));
        const adapter = new MCPToolAdapter(source(new Map([['fixture', connected]])));
        expect(await adapter.getToolsForServer('fixture')).toEqual({});
        expect(Object.keys(await adapter.getToolsForServer('fixture'))).toEqual(['ok']);
        expect(connected.tools).toHaveBeenCalledTimes(2);
        const empty = new MCPToolAdapter(source(new Map()));
        expect(await empty.getAllTools()).toEqual({});
        expect(await empty.getAllToolsInfo()).toEqual([]);
    });

    it('extracts generic metadata/tags and skips vanished or failed clients without dropping successful ones', async () => {
        const connected = client({});
        vi.mocked(connected.listTools).mockResolvedValue({
            tools: [
                {
                    name: 'readProject-record_项目',
                    description: 'Read project 42 a One Two Three Four Five Six Seven Eight Nine',
                    inputSchema: { type: 'object', properties: {} }
                },
                { name: 'missing_description', inputSchema: { type: 'object' } }
            ]
        });
        const failed = client({});
        vi.mocked(failed.listTools).mockRejectedValue(new Error('metadata list failed'));
        const adapter = new MCPToolAdapter(
            source(
                new Map([
                    ['workspace', connected],
                    ['failed', failed]
                ]),
                ['gone', 'failed', 'workspace']
            )
        );
        expect(await adapter.getAllToolsInfo()).toEqual([
            {
                name: 'readProject-record_项目',
                displayName: 'readProject-record 项目',
                description: 'Read project 42 a One Two Three Four Five Six Seven Eight Nine',
                server: 'workspace',
                inputSchema: { type: 'object', properties: {} },
                tags: ['read', 'project', 'record', '项目', '42', 'one', 'two', 'three']
            },
            {
                name: 'missing_description',
                displayName: 'missing description',
                description: 'missing_description',
                server: 'workspace',
                inputSchema: { type: 'object' },
                tags: ['missing', 'description']
            }
        ]);
        expect(connected.listTools).toHaveBeenCalledTimes(1);
        expect(failed.listTools).toHaveBeenCalledTimes(1);
    });
});
