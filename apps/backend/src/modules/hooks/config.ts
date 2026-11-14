import crypto from 'node:crypto';
import fs from 'node:fs';

import type { HookEventName, HooksStatus, HooksView } from '@zhuixun/shared';

import { paths } from '@/config/paths';
import { getHooksSettings } from '@/config/settings-store';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('Hooks');

/**
 * hooks.json 加载、校验与信任判定。
 *
 * 不变量：
 * - 文件只由用户手工编辑；agent 侧 Write/Edit 写不进 `~/.zhuixun`（isProtectedWrite），Bash 涉及该目录强制确认。
 * - 只有「总开关开启 + 当前文件 sha256 等于用户确认过的 hash」时才执行任何 hook；文件一改即回到待信任。
 * - 按 mtime + size 缓存，文件变化无需重启即重新解析、重新比对 hash。
 */

export const HOOK_EVENTS: readonly HookEventName[] = ['PreToolUse', 'PostToolUse', 'Stop'];

export const DEFAULT_HOOK_TIMEOUT_S = 10;
export const MAX_HOOK_TIMEOUT_S = 60;
/** 单事件最多 hook 命令数，防手改文件塞入海量命令拖慢每次工具调用。 */
const MAX_HOOKS_PER_EVENT = 20;

export interface HookCommand {
    command: string;
    /** 超时（秒），已 clamp 到 [1, 60] */
    timeout: number;
}

export interface HookEntry {
    /** 原始 matcher（缺省匹配全部） */
    matcher?: string;
    /** 锚定全名匹配的正则；缺省匹配全部 */
    pattern?: RegExp;
    hooks: HookCommand[];
}

export type HookConfig = Record<HookEventName, HookEntry[]>;

interface LoadedHooks {
    status: Exclude<HooksStatus, 'disabled' | 'active'> | 'ready';
    hash?: string;
    content?: string;
    config?: HookConfig;
    error?: string;
}

let cache: { key: string; loaded: LoadedHooks } | undefined;

function emptyConfig(): HookConfig {
    return { PreToolUse: [], PostToolUse: [], Stop: [] };
}

/** 解析并校验 hooks.json 结构；任何不合法都抛出带说明的错误（整份视为解析错误，不部分生效）。 */
export function parseHooksConfig(raw: string): HookConfig {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是对象');
    const out = emptyConfig();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!HOOK_EVENTS.includes(key as HookEventName)) throw new Error(`不支持的事件：${key}`);
        if (!Array.isArray(value)) throw new Error(`${key} 必须是数组`);
        const event = key as HookEventName;
        let total = 0;
        for (const [i, entry] of value.entries()) {
            if (!entry || typeof entry !== 'object') throw new Error(`${key}[${i}] 必须是对象`);
            const { matcher, hooks } = entry as { matcher?: unknown; hooks?: unknown };
            if (matcher !== undefined && typeof matcher !== 'string')
                throw new Error(`${key}[${i}].matcher 必须是字符串`);
            let pattern: RegExp | undefined;
            if (matcher) {
                try {
                    pattern = new RegExp(`^(?:${matcher})$`);
                } catch {
                    throw new Error(`${key}[${i}].matcher 不是合法正则：${matcher}`);
                }
            }
            if (!Array.isArray(hooks) || hooks.length === 0) throw new Error(`${key}[${i}].hooks 必须是非空数组`);
            const commands: HookCommand[] = hooks.map((h: unknown, j: number) => {
                const item = h as { type?: unknown; command?: unknown; timeout?: unknown };
                if (!item || item.type !== 'command') throw new Error(`${key}[${i}].hooks[${j}].type 仅支持 "command"`);
                if (typeof item.command !== 'string' || !item.command.trim()) {
                    throw new Error(`${key}[${i}].hooks[${j}].command 不能为空`);
                }
                const timeout =
                    typeof item.timeout === 'number' && Number.isFinite(item.timeout)
                        ? Math.min(MAX_HOOK_TIMEOUT_S, Math.max(1, Math.round(item.timeout)))
                        : DEFAULT_HOOK_TIMEOUT_S;
                return { command: item.command, timeout };
            });
            total += commands.length;
            if (total > MAX_HOOKS_PER_EVENT) throw new Error(`${key} 的 hook 命令超过上限 ${MAX_HOOKS_PER_EVENT} 条`);
            out[event].push({ ...(matcher ? { matcher, pattern } : {}), hooks: commands });
        }
    }
    return out;
}

export function hashContent(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 同步读取（工具审批的 matches 是同步调用）；按 mtime + size 缓存。 */
export function loadHooksFile(): LoadedHooks {
    const file = paths.hooksFile();
    let stat: fs.Stats;
    try {
        stat = fs.statSync(file);
    } catch (error) {
        cache = undefined;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
        return { status: 'error', error: 'hooks.json 无法读取' };
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (cache?.key === key) return cache.loaded;
    let loaded: LoadedHooks;
    try {
        const content = fs.readFileSync(file, 'utf8');
        const hash = hashContent(content);
        try {
            loaded = { status: 'ready', hash, content, config: parseHooksConfig(content) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn('hooks.json 解析失败，全部 hooks 不执行', { err: message });
            loaded = { status: 'error', hash, content, error: `解析失败：${message}` };
        }
    } catch (error) {
        log.warn('hooks.json 读取失败，全部 hooks 不执行', { err: error });
        loaded = { status: 'error', error: 'hooks.json 无法读取' };
    }
    cache = { key, loaded };
    return loaded;
}

/** 当前可执行的配置：仅在已启用且已信任时返回，否则 undefined（不执行任何 hook）。 */
export function activeHooksConfig(): HookConfig | undefined {
    const loaded = loadHooksFile();
    if (loaded.status !== 'ready' || !loaded.config) return undefined;
    const settings = getHooksSettings();
    if (!settings.enabled || !settings.trustedHash || settings.trustedHash !== loaded.hash) return undefined;
    return loaded.config;
}

/** 设置页视图。 */
export function hooksView(): HooksView {
    const loaded = loadHooksFile();
    const settings = getHooksSettings();
    const trusted = !!loaded.hash && settings.trustedHash === loaded.hash;
    let status: HooksStatus;
    if (loaded.status !== 'ready') status = loaded.status;
    else if (!trusted) status = 'untrusted';
    else status = settings.enabled ? 'active' : 'disabled';
    const counts = { PreToolUse: 0, PostToolUse: 0, Stop: 0 };
    for (const event of HOOK_EVENTS) {
        counts[event] = loaded.config?.[event].reduce((n, entry) => n + entry.hooks.length, 0) ?? 0;
    }
    return {
        path: paths.hooksFile(),
        status,
        enabled: settings.enabled,
        trusted,
        counts,
        ...(loaded.hash ? { hash: loaded.hash } : {}),
        ...(loaded.content !== undefined ? { content: loaded.content } : {}),
        ...(loaded.error ? { error: loaded.error } : {})
    };
}

/** 测试用：清空文件缓存。 */
export function resetHooksCache(): void {
    cache = undefined;
}
