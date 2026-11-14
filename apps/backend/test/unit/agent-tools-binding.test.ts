import { tool, type ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { resolveAllowedTools } from '@/agent/tools/binding';

const options = { toolCallId: 'binding-call', messages: [], context: {} };

function fixture() {
    const execute = vi.fn(async (input: { command: string }) => ({ output: input.command }));
    const onInputStart = vi.fn<NonNullable<ToolSet[string]['onInputStart']>>(async () => {});
    const Bash = tool({ inputSchema: z.object({ command: z.string() }), execute, onInputStart });
    const Read = tool({ inputSchema: z.object({}), execute: async () => 'read' });
    const pools = {
        shellTools: { Bash, Read, Write: Read },
        webTools: { WebFetch: Read, WebSearch: Read },
        mcpTools: { docs_server_read_page: Read, docs_server_find: Read, other_lookup: Read }
    };
    return { pools, execute, onInputStart, Bash, Read };
}

async function execute(tools: ToolSet, input: unknown) {
    return tools.Bash.execute!(input, options);
}

describe('agent allowed-tools binding', () => {
    it.each([undefined, []])('returns no extras for absent/empty rules %s', (allowed) => {
        expect(resolveAllowedTools(allowed, undefined, fixture().pools)).toEqual({});
    });

    it('normalizes names, supports exact/server/wildcard MCP rules, removes denied rules and ignores unknown rules', async () => {
        const { pools, Read } = fixture();
        const tools = resolveAllowedTools(
            [
                ' Read ',
                'Write',
                'WebFetch',
                'WebSearch',
                'mcp__docs-server__read-page',
                'unknown',
                'mcp__missing__tool'
            ],
            ['Write', 'WebSearch'],
            pools
        );
        expect(Object.keys(tools)).toEqual(['Read', 'WebFetch', 'docs_server_read_page']);
        expect(await tools.Read.execute!({}, options)).toBe('read');
        expect(tools.WebFetch).toBe(Read);
        for (const rule of ['mcp__docs-server', 'mcp__docs-server__*', 'mcp__docs-server__']) {
            const bound = resolveAllowedTools([rule], ['mcp__docs-server__find'], pools);
            expect(Object.keys(bound)).toEqual(['docs_server_read_page']);
            expect(await bound.docs_server_read_page.execute!({}, options)).toBe('read');
        }
        expect(resolveAllowedTools(['mcp__missing', 'mcp__missing__*'], undefined, pools)).toEqual({});
    });

    it('does not fabricate disabled shell/web tools', () => {
        expect(resolveAllowedTools(['Read', 'WebFetch'], undefined, { shellTools: {}, mcpTools: {} })).toEqual({});
        const f = fixture();
        expect(resolveAllowedTools(['Bash(git log:*)'], ['Bash'], f.pools)).toEqual({});
    });

    it('executes only scoped commands and retains the original schema, callback and execution options', async () => {
        const f = fixture();
        const tools = resolveAllowedTools([' Bash( git log:* ) ', 'Bash(pnpm test:*)'], undefined, f.pools);
        expect(tools.Bash).not.toBe(f.Bash);
        expect(tools.Bash.inputSchema).toBe(f.Bash.inputSchema);
        expect(tools.Bash.onInputStart).toBe(f.onInputStart);
        const onInputStart = tools.Bash.onInputStart;
        expect(typeof onInputStart).toBe('function');
        if (typeof onInputStart !== 'function') throw new Error('missing input callback');
        await onInputStart(options);
        expect(f.onInputStart).toHaveBeenCalledExactlyOnceWith(options);
        expect(await execute(tools, { command: 'git log -2' })).toEqual({ output: 'git log -2' });
        expect(await execute(tools, { command: 'pnpm test --filter unit' })).toEqual({
            output: 'pnpm test --filter unit'
        });
        expect(f.execute).toHaveBeenCalledWith({ command: 'git log -2' }, options);
        for (const input of [
            { command: 'git status' },
            { command: 'git log && rm -rf x' },
            { command: 'git log; echo unsafe' },
            { command: null },
            {},
            null,
            'git log'
        ]) {
            expect(await execute(tools, input)).toMatchObject({
                success: false,
                error: expect.stringContaining('git log:*, pnpm test:*')
            });
        }
        expect(f.execute).toHaveBeenCalledTimes(2);
    });

    it.each(['Bash', 'Bash()', 'Bash(unclosed'])(
        'unscoped/malformed rule %s preserves original execution',
        async (rule) => {
            const f = fixture();
            const tools = resolveAllowedTools(['Bash(git log:*)', rule], undefined, f.pools);
            expect(tools.Bash).toBe(f.Bash);
            expect(await execute(tools, { command: 'git status' })).toEqual({ output: 'git status' });
        }
    );

    it('leaves client-only Bash untouched and propagates executor errors', async () => {
        const clientTool = tool({ inputSchema: z.object({ command: z.string() }) });
        expect(
            resolveAllowedTools(['Bash(git log:*)'], [], { shellTools: { Bash: clientTool }, mcpTools: {} }).Bash
        ).toBe(clientTool);
        const f = fixture();
        f.execute.mockRejectedValueOnce(new Error('fake executor failure'));
        const tools = resolveAllowedTools(['Bash(git log:*)'], [], f.pools);
        await expect(execute(tools, { command: 'git log' })).rejects.toThrow('fake executor failure');
    });
});
