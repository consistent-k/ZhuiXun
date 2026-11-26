import fs from 'node:fs/promises';

import { writeFileAtomic } from '@/config/atomic-json';
import { createLogger } from '@/platform/logging/index';

import type { MCPServerConfig } from './manager';

const log = createLogger('MCPConfig');

export interface MCPConfigFile {
    servers: Record<string, Omit<MCPServerConfig, 'name'>>;
}

/** .mcp.json 落盘形态里单个 server 的宽松结构（JSON 反序列化而来，字段均可选） */
interface RawServerConfig {
    connectorId?: string;
    headers?: Record<string, string>;
    transport?: MCPServerConfig['transport'];
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    disabled?: boolean;
    authType?: MCPServerConfig['authType'];
    oauth?: { scope?: string; clientId?: string; clientSecret?: string };
}

const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// 判定「值里是否含占位符」用的无状态正则。绝不能复用带 /g 的 ENV_PLACEHOLDER 做 .test()：
// 带 /g 的正则 .test() 有状态（推进 lastIndex），在循环里复用会从上次匹配位置继续，
// 对本应是占位符的值误判为 false，导致真实密钥被明文写回 .mcp.json。
const ENV_PLACEHOLDER_PRESENT = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * 把配置里的 ${VAR} 占位符替换为 process.env 中的真实值。
 * 这样 .mcp.json 里可以只写占位符，密钥通过环境变量注入，不落盘、不进 git。
 */
function resolvePlaceholders(value: string, serverName: string, key: string): string {
    return value.replace(ENV_PLACEHOLDER, (match, varName: string) => {
        const resolved = process.env[varName];
        if (resolved === undefined) {
            log.warn('占位符未解析', { placeholder: match, server: serverName, key, envVar: varName });
            return '';
        }
        return resolved;
    });
}

function resolveEnvRecord(
    env: Record<string, string> | undefined,
    serverName: string
): Record<string, string> | undefined {
    if (!env) return env;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        resolved[key] = resolvePlaceholders(value, serverName, key);
    }
    return resolved;
}

export async function loadMCPConfig(configPath: string): Promise<MCPConfigFile> {
    try {
        const content = await fs.readFile(configPath, 'utf-8');
        const raw = JSON.parse(content) as { mcpServers?: Record<string, RawServerConfig> };
        const servers: Record<string, Omit<MCPServerConfig, 'name'>> = {};

        for (const [name, config] of Object.entries(raw.mcpServers ?? {})) {
            servers[name] = {
                connectorId: config.connectorId,
                headers: resolveEnvRecord(config.headers, name),
                transport: config.transport || 'stdio',
                command: config.command,
                args: config.args?.map((arg: string) => resolvePlaceholders(arg, name, 'args')),
                env: resolveEnvRecord(config.env, name),
                url: config.url ? resolvePlaceholders(config.url, name, 'url') : undefined,
                disabled: !!config.disabled,
                authType: config.authType || 'none',
                oauth: config.oauth
                    ? {
                          scope: config.oauth.scope,
                          clientId: config.oauth.clientId,
                          clientSecret: config.oauth.clientSecret
                      }
                    : undefined
            };
        }

        log.info('已加载配置', { count: Object.keys(servers).length, configPath });
        return { servers };
    } catch (error) {
        log.error('加载配置失败', { configPath, err: error });
        return { servers: {} };
    }
}

export function mcpConfigToServerConfigs(config: MCPConfigFile): MCPServerConfig[] {
    return Object.entries(config.servers).map(([name, cfg]) => ({
        name,
        ...cfg
    }));
}

/**
 * 仅当值仍等于原表达式的解析结果才恢复占位符；变量名不一定等于 env 键，
 * 且 args/url 也支持占位符。逐项还原能防止「读后保存」把运行时密钥写回磁盘，
 * 同时保留用户明确编辑的新值。
 */
function restorePlaceholder(value: string, original: unknown, serverName: string, key: string): string {
    if (
        typeof original === 'string' &&
        ENV_PLACEHOLDER_PRESENT.test(original) &&
        value === resolvePlaceholders(original, serverName, key)
    ) {
        return original;
    }
    return value;
}

/**
 * 将内存中的配置持久化到 .mcp.json。
 * 写入前会读取现有文件，对 env/args/url 中未修改的解析值还原 ${VAR} 占位符。
 */
export async function saveMCPConfig(configPath: string, config: MCPConfigFile): Promise<void> {
    // 读取现有文件用于占位符还原
    let existingRaw: { mcpServers?: Record<string, unknown> } = {};
    try {
        const content = await fs.readFile(configPath, 'utf-8');
        existingRaw = JSON.parse(content);
    } catch {
        // 文件不存在或解析失败，忽略
    }

    const servers: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(config.servers)) {
        const existing = (existingRaw.mcpServers?.[name] as Record<string, unknown> | undefined) || {};
        const serverEntry: Record<string, unknown> = {
            transport: cfg.transport,
            connectorId: cfg.connectorId
        };

        if (cfg.headers) {
            const previous = (existing.headers as Record<string, unknown> | undefined) ?? {};
            serverEntry.headers = Object.fromEntries(
                Object.entries(cfg.headers).map(([key, value]) => [
                    key,
                    restorePlaceholder(value, previous[key], name, key)
                ])
            );
        }
        if (cfg.authType && cfg.authType !== 'none') {
            serverEntry.authType = cfg.authType;
        }
        if (cfg.oauth) {
            const oauth: Record<string, unknown> = {};
            if (cfg.oauth.scope) oauth.scope = cfg.oauth.scope;
            if (cfg.oauth.clientId) oauth.clientId = cfg.oauth.clientId;
            if (cfg.oauth.clientSecret) {
                oauth.clientSecret = cfg.oauth.clientSecret;
            }
            serverEntry.oauth = oauth;
        }

        if (cfg.disabled) {
            serverEntry.disabled = true;
        }

        if (cfg.transport === 'stdio') {
            serverEntry.command = cfg.command;
            serverEntry.args = cfg.args?.map((value, index) =>
                restorePlaceholder(value, (existing.args as unknown[] | undefined)?.[index], name, 'args')
            );
            if (cfg.env) {
                const existingEnv = (existing.env as Record<string, unknown> | undefined) || {};
                const resolvedEnv: Record<string, string> = {};
                for (const [key, value] of Object.entries(cfg.env)) {
                    resolvedEnv[key] = restorePlaceholder(value, existingEnv[key], name, key);
                }
                serverEntry.env = resolvedEnv;
            }
        } else if (cfg.transport === 'sse' || cfg.transport === 'streamableHttp') {
            serverEntry.url =
                cfg.url === undefined ? undefined : restorePlaceholder(cfg.url, existing.url, name, 'url');
        }

        servers[name] = serverEntry;
    }

    const output = { mcpServers: servers };
    await writeFileAtomic(configPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
    await fs.chmod(configPath, 0o600);
    log.info('已保存配置', { count: Object.keys(servers).length, configPath });
}
