/**
 * 渠道注册入口：所有渠道（含 Telegram / 微信）均以**第三方插件**形态从用户可写目录
 * `~/.zhuixun/channels/plugins/<id>/` 动态加载——后端不再内置任何 provider 实现。
 *
 * 加载：settings.channels.plugins 里登记的 id → 读 `plugin.json` → 用绝对路径 file URL
 * 动态 import（路径是运行时变量，esbuild 不内联，打包态保留为真实运行时 import）→ register(manager, ctx)。
 * 插件产物自包含、运行时不 import 本仓任何包（契约与 processMessage/sleep 全经 ctx 注入）。
 *
 * 安全：只加载允许列表里的 id；id 限 [A-Za-z0-9_-]（防路径穿越）；entry 必须解析在插件目录内；
 * 仅从受信用户目录加载。安装渠道插件 = 授予其与后端同等权限，需用户主动登记。
 * 内置渠道以「workspace 包 + `pnpm channels:install-plugins` 安装到插件目录」提供，见该脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ChannelContext, ChannelManager } from '@zhuixun/channels-core';

import { paths } from '@/config/paths';
import { getChannelsSettings } from '@/config/settings-store';
import { createLogger } from '@/platform/logging/index';

import { channelManager } from './channel-manager';

const log = createLogger('ChannelRegistry');

interface ChannelPluginModule {
    register?: (manager: ChannelManager, ctx: ChannelContext) => void;
}

interface PluginManifest {
    name?: string;
    /** 入口文件（相对插件目录），缺省 index.mjs。 */
    entry?: string;
}

/** 从用户目录按允许列表加载渠道插件（dev 与打包态一致）。 */
async function loadDirPlugins(
    ctx: ChannelContext,
    ids: string[],
    bundled?: Readonly<Record<string, string>>
): Promise<void> {
    const base = path.join(paths.channelsDir(), 'plugins');
    for (const id of ids) {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
            log.error('非法插件 id（禁路径穿越），跳过', { id });
            continue;
        }
        const dir = path.join(base, id);
        try {
            const manifestPath = path.join(dir, 'plugin.json');
            const bundledEntry = !fs.existsSync(manifestPath) ? bundled?.[id] : undefined;
            const manifest = bundledEntry
                ? { name: id }
                : (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest);
            const entryPath = bundledEntry ?? path.resolve(dir, manifest.entry || 'index.mjs');
            // entry 必须仍在插件目录内（防 entry: "../../evil.js"）
            if (
                !bundledEntry &&
                entryPath !== path.resolve(dir) &&
                !entryPath.startsWith(path.resolve(dir) + path.sep)
            ) {
                log.error('插件 entry 越界，跳过', { id, entry: manifest.entry });
                continue;
            }
            // 运行时变量路径：esbuild 不内联，打包态保留为真实运行时 import
            const mod = (await import(pathToFileURL(entryPath).href)) as ChannelPluginModule;
            if (typeof mod.register === 'function') {
                mod.register(channelManager, ctx);
                log.info('渠道插件已注册', { id, name: manifest.name });
            } else {
                log.error('插件缺少 register 导出，跳过', { id });
            }
        } catch (err) {
            log.error('插件加载失败', { id, err: String(err) });
        }
    }
}

export async function registerChannels(ctx: ChannelContext, bundled?: Readonly<Record<string, string>>): Promise<void> {
    const ids = getChannelsSettings().plugins ?? Object.keys(bundled ?? {});
    if (ids.length) await loadDirPlugins(ctx, ids, bundled);
    else log.info('未配置渠道插件（settings.channels.plugins 为空）');
    log.info('渠道注册完成', { channels: channelManager.list().map((c) => c.id) });
}
