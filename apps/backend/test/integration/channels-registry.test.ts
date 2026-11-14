import fs from 'node:fs/promises';
import path from 'node:path';

import { processMessage, sleep, type Channel, type ChannelContext } from '@zhuixun/channels-core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import { updateChannelsSettings } from '@/config/settings-store';
import { buildChannelRuntime, channelManager, registerChannels } from '@/modules/channels';
import { flushLogs } from '@/platform/logging/index';

const pluginRoot = path.join(paths.channelsDir(), 'plugins');
const createdDirs = new Set<string>();
const ctx: ChannelContext = {
    runtime: buildChannelRuntime(),
    processMessage,
    sleep,
    runAgent: vi.fn(async () => {
        throw new Error('注册插件不得调用模型');
    })
};

interface FixtureChannel extends Channel {
    context: ChannelContext;
    startCount: number;
    stopCount: number;
    lastSignal?: AbortSignal;
}

// 插件真实经过 manifest、file URL 和动态 import；只有 provider 是无进程、无网络的 fake。
function pluginSource(id: string): string {
    return `export function register(manager, ctx) {
        let finish;
        manager.register({
            id: ${JSON.stringify(id)}, name: 'Fake plugin', status: 'idle', context: ctx,
            startCount: 0, stopCount: 0,
            isConfigured() { return true; },
            getStatusInfo() { return [this.status]; },
            start({ abortSignal }) {
                this.startCount++;
                this.lastSignal = abortSignal;
                return new Promise(resolve => {
                    finish = resolve;
                    abortSignal.addEventListener('abort', resolve, { once: true });
                });
            },
            async stop() { this.stopCount++; finish?.(); }
        });
    }`;
}

async function writePlugin(id: string, manifest: unknown, source?: string, entry = 'index.mjs'): Promise<void> {
    const dir = path.join(pluginRoot, id);
    createdDirs.add(dir);
    await fs.mkdir(path.dirname(path.join(dir, entry)), { recursive: true });
    await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
    if (source !== undefined) await fs.writeFile(path.join(dir, entry), source);
}

afterEach(async () => {
    await channelManager.stopAll();
    updateChannelsSettings({ plugins: [] });
    await flushLogs();
    vi.restoreAllMocks();
});

afterAll(async () => {
    for (const dir of createdDirs) await fs.rm(dir, { force: true, recursive: true });
});

describe('渠道插件注册和生命周期集成', () => {
    it('缺省或空允许列表都不加载插件，默认 manager 为空', async () => {
        const info = vi.spyOn(console, 'log').mockImplementation(() => {});
        await registerChannels(ctx);
        updateChannelsSettings({ plugins: [] });
        await registerChannels(ctx);
        expect(channelManager.list()).toEqual([]);
        expect(info.mock.calls.filter(([line]) => String(line).includes('未配置渠道插件'))).toHaveLength(2);
        expect(ctx.runAgent).not.toHaveBeenCalled();
    });

    it('仅加载允许列表、支持默认和嵌套入口、注入同一个上下文；重复注册不替换实例', async () => {
        await writePlugin('registry-default', { name: '默认入口' }, pluginSource('registry-default'));
        await writePlugin(
            'registry-nested',
            { name: '嵌套入口', entry: 'dist/provider.mjs' },
            pluginSource('registry-nested'),
            'dist/provider.mjs'
        );
        await writePlugin('registry-unlisted', {}, pluginSource('registry-unlisted'));
        updateChannelsSettings({ plugins: ['registry-default', 'registry-nested'] });
        await registerChannels(ctx);
        const channel = channelManager.get('registry-default') as FixtureChannel;
        const nested = channelManager.get('registry-nested') as FixtureChannel;
        expect(channel.context).toBe(ctx);
        expect(nested.context).toBe(ctx);
        expect(channelManager.get('registry-unlisted')).toBeUndefined();
        expect(channel.getStatusInfo()).toEqual(['idle']);
        expect(channel.isConfigured()).toBe(true);

        await registerChannels(ctx);
        expect(channelManager.get(channel.id)).toBe(channel);
        expect(channelManager.list().filter(({ id }) => id === channel.id)).toHaveLength(1);

        await channelManager.start(channel.id);
        expect(channel.status).toBe('running');
        expect(channel.startCount).toBe(1);
        expect(channelManager.isRunning(channel.id)).toBe(true);
        expect(channel.lastSignal!.aborted).toBe(false);
        await expect(channelManager.start(channel.id)).rejects.toThrow('已在运行');
        await channelManager.stop(channel.id);
        expect(channel.lastSignal!.aborted).toBe(true);
        expect(channel.stopCount).toBe(1);
        expect(channelManager.isRunning(channel.id)).toBe(false);
        expect(channel.status).toBe('idle');
        await channelManager.stop(channel.id);
        expect(channel.stopCount).toBe(1);

        await channelManager.start(channel.id);
        await channelManager.start(nested.id);
        await channelManager.stopAll();
        expect(channel.startCount).toBe(2);
        expect(channel.stopCount).toBe(2);
        expect(nested.stopCount).toBe(1);
        expect(channelManager.isRunning(channel.id)).toBe(false);
        expect(channelManager.isRunning(nested.id)).toBe(false);
    });

    it('拒绝非法 id 和逃逸 entry，坏插件不会阻塞后续合法插件', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        await writePlugin('registry-traversal', { entry: '../registry-escape/index.mjs' });
        await writePlugin('registry-escape', {}, 'throw new Error("不应执行逃逸模块");');
        await writePlugin('registry-absolute', { entry: path.join(pluginRoot, 'registry-escape', 'index.mjs') });
        await writePlugin('registry-no-register', {}, 'export const register = 42;');
        await writePlugin('registry-throw-import', {}, 'throw new Error("fake import failure");');
        await writePlugin(
            'registry-throw-register',
            {},
            'export function register() { throw new Error("fake register failure"); }'
        );
        await writePlugin('registry-missing-entry', {});
        await writePlugin('registry-null-manifest', null);
        await writePlugin('registry-directory-entry', { entry: '.' });
        await writePlugin('registry-malformed', {});
        await fs.writeFile(path.join(pluginRoot, 'registry-malformed', 'plugin.json'), '{ invalid json');
        await writePlugin('registry-after-errors', {}, pluginSource('registry-after-errors'));

        updateChannelsSettings({
            plugins: [
                '../registry-escape',
                '/registry-escape',
                '',
                'registry-traversal',
                'registry-absolute',
                'registry-no-register',
                'registry-throw-import',
                'registry-throw-register',
                'registry-missing-entry',
                'registry-null-manifest',
                'registry-directory-entry',
                'registry-malformed',
                'registry-nonexistent',
                'registry-after-errors'
            ]
        });
        await expect(registerChannels(ctx)).resolves.toBeUndefined();
        expect(channelManager.get('registry-after-errors')).toMatchObject({ status: 'idle' });
        expect(channelManager.get('registry-escape')).toBeUndefined();
        const lines = errors.mock.calls.map(([line]) => String(line));
        expect(lines.filter((line) => line.includes('非法插件 id'))).toHaveLength(3);
        expect(lines.filter((line) => line.includes('插件 entry 越界'))).toHaveLength(2);
        expect(lines.filter((line) => line.includes('插件缺少 register 导出'))).toHaveLength(1);
        expect(lines.filter((line) => line.includes('插件加载失败'))).toHaveLength(7);
        expect(lines.some((line) => line.includes('fake import failure'))).toBe(true);
        expect(lines.some((line) => line.includes('fake register failure'))).toBe(true);
        expect(lines.some((line) => line.includes('不应执行逃逸模块'))).toBe(false);
    });
});
