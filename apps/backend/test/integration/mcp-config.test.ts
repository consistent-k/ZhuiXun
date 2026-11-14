import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadMCPConfig, mcpConfigToServerConfigs, saveMCPConfig } from '@/modules/mcp/config';

import { createTempData } from '../helpers/temp-data';

describe('MCP config real-file round trips', () => {
    let temp: Awaited<ReturnType<typeof createTempData>>;
    let file: string;

    beforeEach(async () => {
        temp = await createTempData('mcp-config-');
        file = path.join(temp.root, '.mcp.json');
        vi.stubEnv('MCP_TEST_SECRET', 'fixture-secret-not-a-credential');
        vi.stubEnv('MCP_TEST_HOST', 'fixture.invalid');
        vi.stubEnv('MCP_TEST_MISSING', undefined);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await temp.cleanup();
    });

    it('resolves defaults, multiple occurrences, missing variables and converts named servers', async () => {
        await fs.writeFile(
            file,
            JSON.stringify({
                mcpServers: {
                    local: {
                        command: 'fixture-command',
                        args: ['${MCP_TEST_SECRET}/${MCP_TEST_SECRET}', '${MCP_TEST_MISSING}'],
                        env: {
                            TOKEN: 'Bearer ${MCP_TEST_SECRET}',
                            LITERAL: '$MCP_TEST_SECRET',
                            INVALID: '${not-valid}',
                            EMPTY: '${MCP_TEST_MISSING}'
                        }
                    },
                    remote: {
                        transport: 'streamableHttp',
                        url: 'https://${MCP_TEST_HOST}/mcp',
                        disabled: 1,
                        authType: 'oauth',
                        oauth: {
                            scope: 'read write',
                            clientId: 'fixture-id',
                            clientSecret: 'fixture-client-secret'
                        }
                    }
                }
            })
        );
        const loaded = await loadMCPConfig(file);
        expect(loaded.servers.local).toEqual({
            transport: 'stdio',
            command: 'fixture-command',
            args: ['fixture-secret-not-a-credential/fixture-secret-not-a-credential', ''],
            env: {
                TOKEN: 'Bearer fixture-secret-not-a-credential',
                LITERAL: '$MCP_TEST_SECRET',
                INVALID: '${not-valid}',
                EMPTY: ''
            },
            url: undefined,
            disabled: false,
            authType: 'none',
            oauth: undefined
        });
        expect(loaded.servers.remote).toMatchObject({
            url: 'https://fixture.invalid/mcp',
            disabled: true,
            authType: 'oauth',
            oauth: { scope: 'read write', clientId: 'fixture-id', clientSecret: 'fixture-client-secret' }
        });
        expect(mcpConfigToServerConfigs(loaded)).toEqual([
            { name: 'local', ...loaded.servers.local },
            { name: 'remote', ...loaded.servers.remote }
        ]);
    });

    it('preserves env aliases/composites, repeated placeholders, args and URL without leaking resolved secrets', async () => {
        const original = {
            mcpServers: {
                local: {
                    transport: 'stdio',
                    command: 'fixture-command',
                    args: ['--token=${MCP_TEST_SECRET}', '${MCP_TEST_MISSING}'],
                    env: {
                        ALIAS: '${MCP_TEST_SECRET}',
                        SECOND: '${MCP_TEST_SECRET}',
                        COMPOSITE: 'Bearer ${MCP_TEST_SECRET}:${MCP_TEST_HOST}',
                        MISSING: '${MCP_TEST_MISSING}'
                    }
                },
                remote: { transport: 'sse', url: 'https://${MCP_TEST_HOST}/${MCP_TEST_SECRET}' }
            }
        };
        await fs.writeFile(file, JSON.stringify(original));
        const loaded = await loadMCPConfig(file);
        await saveMCPConfig(file, loaded);
        const saved = await fs.readFile(file, 'utf8');
        expect(JSON.parse(saved)).toEqual(original);
        expect(saved).not.toContain('fixture-secret-not-a-credential');
        expect(saved.endsWith('\n')).toBe(true);
        expect(await loadMCPConfig(file)).toEqual(loaded);
    });

    it('persists intentional edits instead of restoring stale placeholders', async () => {
        await fs.writeFile(
            file,
            JSON.stringify({
                mcpServers: { local: { env: { SAME: '${MCP_TEST_SECRET}', EDIT: '${MCP_TEST_SECRET}' } } }
            })
        );
        await saveMCPConfig(file, {
            servers: {
                local: {
                    transport: 'stdio',
                    command: 'fixture-command',
                    env: { SAME: 'fixture-secret-not-a-credential', EDIT: 'user-edited', NEW: 'new-value' },
                    disabled: true
                },
                remote: {
                    transport: 'streamableHttp',
                    url: 'https://edited.invalid/mcp',
                    authType: 'oauth',
                    oauth: { scope: 'read', clientId: 'id', clientSecret: 'fixture-secret' }
                }
            }
        });
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
            mcpServers: {
                local: {
                    transport: 'stdio',
                    command: 'fixture-command',
                    env: { SAME: '${MCP_TEST_SECRET}', EDIT: 'user-edited', NEW: 'new-value' },
                    disabled: true
                },
                remote: {
                    transport: 'streamableHttp',
                    url: 'https://edited.invalid/mcp',
                    authType: 'oauth',
                    oauth: { scope: 'read', clientId: 'id', clientSecret: 'fixture-secret' }
                }
            }
        });
    });

    it('does not restore edited args/URL and omits empty optional OAuth fields', async () => {
        await fs.writeFile(
            file,
            JSON.stringify({
                mcpServers: {
                    local: { transport: 'stdio', args: ['${MCP_TEST_SECRET}'], env: { TOKEN: '${MCP_TEST_SECRET}' } },
                    remote: { transport: 'sse', url: 'https://${MCP_TEST_HOST}' }
                }
            })
        );
        const loaded = await loadMCPConfig(file);
        loaded.servers.local.args = ['user-edited'];
        loaded.servers.local.env = undefined;
        loaded.servers.remote.url = 'https://edited.invalid';
        loaded.servers.remote.oauth = {};
        await saveMCPConfig(file, loaded);
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
            mcpServers: {
                local: { transport: 'stdio', args: ['user-edited'] },
                remote: { transport: 'sse', url: 'https://edited.invalid', oauth: {} }
            }
        });
    });

    it('returns empty for missing/malformed files and missing server sections', async () => {
        expect(await loadMCPConfig(file)).toEqual({ servers: {} });
        await fs.writeFile(file, '{invalid');
        expect(await loadMCPConfig(file)).toEqual({ servers: {} });
        await fs.writeFile(file, '{}');
        expect(await loadMCPConfig(file)).toEqual({ servers: {} });
        expect(mcpConfigToServerConfigs({ servers: {} })).toEqual([]);
    });

    it('creates/replaces missing and malformed files and propagates actual write errors', async () => {
        const cfg = { servers: { remote: { transport: 'sse' as const } } };
        await saveMCPConfig(file, cfg);
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ mcpServers: { remote: { transport: 'sse' } } });
        await fs.writeFile(file, '{broken');
        await saveMCPConfig(file, { servers: {} });
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ mcpServers: {} });
        await expect(saveMCPConfig(temp.root, cfg)).rejects.toMatchObject({ code: 'EISDIR' });
    });
});
