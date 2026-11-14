import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

/**
 * 内置更新渠道注册表（主进程私有）。
 *
 * 设计约束：
 * - 渠道（含 feed 地址）全部硬编码在此，打进应用二进制、随签名可信；用户只能在这些 id 里选一个，
 *   既不能填地址、也不能新增渠道。新增渠道 = 往 CHANNELS 加一条（可扩展）。
 * - 地址绝不落 settings.json（用户可编辑 / 可经 HTTP 写），避免把更新源指向任意地址
 *   （更新源 = 代码执行入口，是信任边界）。
 * - 用户的「选择」仅持久化一个渠道 id 到 app.getPath('userData')/update-channel.json，读回时按本表
 *   白名单校验，非法 id 回落默认渠道；即便手改该文件，最坏也只能切到另一个内置渠道，无法注入地址。
 */

/** electron-updater setFeedURL 可接受的 feed 形态（本应用用到 github / generic 两类）。 */
export type UpdateFeed = { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string };

/** 内置渠道定义（主进程内部用，含地址，不下发渲染进程）。 */
export interface UpdateChannelDef {
    /** 渠道唯一 id（持久化与 IPC 传递用）。 */
    id: string;
    /** 渠道展示名（设置页单选项文案）。 */
    displayName: string;
    /** electron-updater feed 配置。 */
    feed: UpdateFeed;
    /** macOS 无签名 / 通用「前往下载」打开的页面；缺省回落 feed 推导。 */
    downloadPageUrl?: string;
}

/** 渠道对渲染进程的脱敏视图（仅 id + 显示名，绝不含地址）。 */
export interface UpdateChannelView {
    id: string;
    displayName: string;
}

// GitHub owner/repo 须与 electron-builder.yml 的 publish 一致。
const GITHUB_OWNER = 'consistent-k';
const GITHUB_REPO = 'zhuixun-agent';

/**
 * 内置渠道清单。第一项为默认渠道。
 * generic 类渠道的 url 必须托管 electron-builder 全套 feed（latest*.yml + 安装包 + .blockmap）。
 */
export const CHANNELS: readonly UpdateChannelDef[] = [
    {
        id: 'github',
        displayName: 'GitHub（默认）',
        feed: { provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO },
        downloadPageUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    },
    {
        id: 'obs',
        displayName: 'OBS 镜像',
        // TODO(发布): 换成实际 OBS 公读前缀（托管 latest*.yml + 安装包 + .blockmap）。
        feed: { provider: 'generic', url: 'https://example-obs.invalid/zhuixun/' },
        downloadPageUrl: 'https://example-obs.invalid/zhuixun/'
    }
];

/** 默认渠道定义（清单第一项；CHANNELS 为非空字面量常量，恒存在）。 */
const DEFAULT_CHANNEL = CHANNELS[0];

function storeFile(): string {
    return path.join(app.getPath('userData'), 'update-channel.json');
}

/** 读持久化的渠道 id；文件缺失 / 坏 JSON / 未知 id 一律回落默认。 */
export function getSelectedChannelId(): string {
    try {
        const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as { channelId?: unknown };
        const id = typeof raw.channelId === 'string' ? raw.channelId : undefined;
        if (id && CHANNELS.some((c) => c.id === id)) return id;
    } catch {
        // 文件不存在或坏 JSON：回落默认，不告警（首次启动属正常）。
    }
    return DEFAULT_CHANNEL.id;
}

/**
 * 持久化渠道选择。仅接受内置 id（白名单校验），非法则抛错由上层拒绝。
 * @param id 内置渠道 id
 * @returns 实际生效的渠道 id
 */
export function setSelectedChannelId(id: string): string {
    if (!CHANNELS.some((c) => c.id === id)) {
        throw new Error(`未知更新渠道: ${id}`);
    }
    const file = storeFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ channelId: id }, null, 2) + '\n', { encoding: 'utf-8' });
    fs.renameSync(tmp, file);
    return id;
}

/** 按 id 取渠道定义；未命中回落默认渠道（永不返回 undefined）。 */
export function resolveChannel(id: string): UpdateChannelDef {
    return CHANNELS.find((c) => c.id === id) ?? DEFAULT_CHANNEL;
}

/** 当前生效渠道定义（读持久化 id + 回落）。 */
export function currentChannel(): UpdateChannelDef {
    return resolveChannel(getSelectedChannelId());
}

/** 渲染进程可见的渠道清单（脱敏，仅 id + 显示名）。 */
export function listChannelViews(): UpdateChannelView[] {
    return CHANNELS.map((c) => ({ id: c.id, displayName: c.displayName }));
}

/**
 * 计算某渠道的「前往下载 / release」页面地址。
 * github 命中版本时给 tag 页；否则取渠道显式 downloadPageUrl，再回落 generic url / release latest。
 * @param channel 渠道定义
 * @param version 命中的新版本号（可选）
 */
export function downloadPageFor(channel: UpdateChannelDef, version?: string): string {
    if (channel.feed.provider === 'github') {
        const base = `https://github.com/${channel.feed.owner}/${channel.feed.repo}/releases`;
        return version ? `${base}/tag/v${version}` : (channel.downloadPageUrl ?? `${base}/latest`);
    }
    return channel.downloadPageUrl ?? channel.feed.url;
}
