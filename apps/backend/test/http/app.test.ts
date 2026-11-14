import { describe, expect, it, vi } from 'vitest';

import defaultApp, { createApp } from '@/bootstrap/app';
import * as mcpModule from '@/modules/mcp';
import { MCPClientManager } from '@/modules/mcp';
import { SkillRegistry } from '@/modules/skills';

describe('HTTP composition root', () => {
    it('can serve health without initializing real services', async () => {
        const app = createApp(() => undefined);
        const response = await app.request('/health');
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            status: 'unavailable',
            ready: false,
            mcp: 'unknown'
        });
    });

    it('lazily resolves every service getter before and after initialization', async () => {
        const unavailable = createApp(() => undefined);
        for (const url of ['/api/debug/tools', '/api/skills', '/api/skillhub/search', '/api/mcp/servers']) {
            const response = await unavailable.request(url);
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ code: 503 });
        }
        const chat = await unavailable.request('/api/chat/stream', { method: 'POST' });
        expect(chat.status).toBe(503);
        expect(await chat.json()).toMatchObject({ code: 503 });

        const mcp = new MCPClientManager([]);
        const registry = new SkillRegistry(mcp, '/nonexistent-test-skills');
        const app = createApp(() => ({
            mcp,
            registry,
            mcpConfigPath: '/fake/mcp.json',
            runtime: { ready: true, mcp: 'ok', skills: 0, dangerSkipPermissions: false, startedAt: 'test' },
            automationScheduler: { start: async () => {}, dispose: async () => {}, requestReschedule: () => {} }
        }));
        for (const url of ['/api/debug/tools', '/api/skills', '/api/mcp/servers']) {
            const response = await app.request(url);
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ code: 0 });
        }
        const health = await app.request('/health');
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ status: 'ok' });
        const invalidChat = await app.request('/api/chat/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        expect(invalidChat.status).toBe(400);
        expect(await invalidChat.json()).toMatchObject({ code: 400 });
        const missingMarket = await app.request('/api/skillhub/skills/bad%21');
        expect(missingMarket.status).toBe(400);
        expect(await missingMarket.json()).toMatchObject({ code: 400 });
        // 通过真实 toggle 路由验证组合根的配置路径 getter，只替换落盘边界。
        const save = vi.spyOn(mcpModule, 'saveMCPConfig').mockResolvedValue(undefined);
        try {
            for (const available of [true, false]) {
                const manager = new MCPClientManager([
                    { name: 'disabled', transport: 'stdio', command: 'fake', disabled: false }
                ]);
                let initialized = true;
                const mounted = createApp(() => {
                    if (!initialized) return undefined;
                    return {
                        mcp: manager,
                        registry,
                        mcpConfigPath: '/fake/mcp.json',
                        runtime: { ready: true, mcp: 'ok', skills: 0, dangerSkipPermissions: false, startedAt: 'test' },
                        automationScheduler: {
                            start: async () => {},
                            dispose: async () => {},
                            requestReschedule: () => {}
                        }
                    };
                });
                const disable = vi.spyOn(manager, 'disableServer').mockImplementation(async () => {
                    initialized = available;
                });
                try {
                    const toggled = await mounted.request('/api/mcp/servers/disabled/toggle', { method: 'PATCH' });
                    expect(toggled.status).toBe(200);
                    expect(await toggled.json()).toMatchObject({ code: 0, data: { disabled: true } });
                    expect(save).toHaveBeenLastCalledWith(
                        available ? '/fake/mcp.json' : '',
                        expect.objectContaining({ servers: expect.any(Object) })
                    );
                } finally {
                    disable.mockRestore();
                }
            }
        } finally {
            save.mockRestore();
        }
        const defaultHealth = await defaultApp.request('/health');
        expect(defaultHealth.status).toBe(503);
        expect(await defaultHealth.json()).toMatchObject({ status: 'unavailable' });
    });

    it('returns the standard not-found envelope without a socket', async () => {
        const app = createApp(() => undefined);
        const response = await app.request('/missing');
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ code: 404, message: 'Not found' });
    });
});
