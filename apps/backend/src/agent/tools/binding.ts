import type { ToolSet } from 'ai';

import { matchesCommandScope } from '@/platform/command';
import { createLogger } from '@/platform/logging/index';
import { buildPrefixedToolName } from '@/platform/tool-naming';

const log = createLogger('ToolBinding');

/** 内置 shell 工具名（与 agent.ts 的 SHELL_TOOL_NAMES 保持一致）。 */
const SHELL_TOOLS = ['Bash', 'Read', 'Write'];

/** 内置 Web 工具名（与 runner 的 WEB_TOOL_NAMES 保持一致）。 */
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/** 取规则的基名：去掉 `Bash(...)` 的括号限定部分，只保留工具名。 */
function ruleBase(rule: string): string {
    const trimmed = rule.trim();
    const paren = trimmed.indexOf('(');
    return paren >= 0 ? trimmed.slice(0, paren).trim() : trimmed;
}

/** 解析 `Bash` / `Bash(git log:*)` 规则：返回是否为 Bash 规则，及命令级 scope 模式（无括号表示不限制）。 */
function parseBashScope(rule: string): { isBash: boolean; pattern?: string } {
    const trimmed = rule.trim();
    if (ruleBase(trimmed) !== 'Bash') return { isBash: false };
    const paren = trimmed.indexOf('(');
    if (paren < 0) return { isBash: true }; // 裸 Bash：不限制命令
    const close = trimmed.lastIndexOf(')');
    const inner = (close > paren ? trimmed.slice(paren + 1, close) : '').trim();
    return { isBash: true, pattern: inner || undefined };
}

/**
 * 把一条 allowed-tools 规则解析成命中的运行时工具名，逐个交给 sink。
 * 命中 0 个时返回 false（供调用方记 warning）。
 *
 * 映射（Claude Code 风格 → 本项目运行时名）：
 * - `Bash`/`Read`/`Write`、`Bash(cmd:*)` → 内置 shell 工具（命令级 scoping 是二期，这里只认基名）
 * - `WebFetch`/`WebSearch` → 内置 Web 工具（是否真正可用取决于设置页开关）
 * - `mcp__<server>__<tool>` → buildPrefixedToolName(server, tool)
 * - `mcp__<server>` / `mcp__<server>__*` → 该 server 下全部工具（前缀匹配）
 */
function applyRule(rule: string, mcpNames: string[], sink: (name: string) => void): boolean {
    const base = ruleBase(rule);
    let matched = false;

    if (SHELL_TOOLS.includes(base) || WEB_TOOLS.includes(base)) {
        sink(base);
        return true;
    }

    if (base.startsWith('mcp__')) {
        const rest = base.slice('mcp__'.length);
        const sepIdx = rest.indexOf('__');
        if (sepIdx < 0) {
            // 整个 server：mcp__<server>
            const prefix = buildPrefixedToolName(rest, '');
            for (const n of mcpNames) {
                if (n.startsWith(prefix)) {
                    sink(n);
                    matched = true;
                }
            }
        } else {
            const server = rest.slice(0, sepIdx);
            const tool = rest.slice(sepIdx + 2);
            if (tool === '*' || tool === '') {
                const prefix = buildPrefixedToolName(server, '');
                for (const n of mcpNames) {
                    if (n.startsWith(prefix)) {
                        sink(n);
                        matched = true;
                    }
                }
            } else {
                const exact = buildPrefixedToolName(server, tool);
                if (mcpNames.includes(exact)) {
                    sink(exact);
                    matched = true;
                }
            }
        }
    }

    return matched;
}

/**
 * 按 allowed-tools / disallowed-tools 规则，从已有工具（内置 shell + 已注册 MCP）里
 * 解析出该技能可用的工具集。allowed 为空时返回空集（该技能不额外挂载已有工具）。
 * 未命中的规则记 warning，不静默丢。
 */
export function resolveAllowedTools(
    allowed: string[] | undefined,
    disallowed: string[] | undefined,
    available: { shellTools: ToolSet; webTools?: ToolSet; mcpTools: ToolSet }
): ToolSet {
    if (!allowed || allowed.length === 0) return {};

    const mcpNames = Object.keys(available.mcpTools);
    const chosen = new Set<string>();

    // 收集 Bash 命令级 scope：出现任一裸 `Bash` 即不限制；否则累计 `Bash(pattern)` 的 pattern。
    const bashScopes: string[] = [];
    let bashUnrestricted = false;
    for (const rule of allowed) {
        const { isBash, pattern } = parseBashScope(rule);
        if (!isBash) continue;
        if (pattern) bashScopes.push(pattern);
        else bashUnrestricted = true;
    }

    for (const rule of allowed) {
        const ok = applyRule(rule, mcpNames, (n) => chosen.add(n));
        if (!ok) log.warn('allowed-tools 规则未命中任何工具，已忽略', { rule });
    }
    for (const rule of disallowed || []) {
        applyRule(rule, mcpNames, (n) => chosen.delete(n));
    }

    const result: ToolSet = {};
    for (const name of chosen) {
        const tool = available.shellTools[name] ?? available.webTools?.[name] ?? available.mcpTools[name];
        if (tool) result[name] = tool;
    }

    // 命令级 scoping：仅声明了 `Bash(pattern)` 而无裸 `Bash` 时，包裹 Bash 工具，
    // 执行前校验命令是否落在允许的 scope 内；不匹配返回错误结果（不抛错、不绕过审批）。
    if (result.Bash && bashScopes.length > 0 && !bashUnrestricted) {
        result.Bash = wrapBashWithScope(result.Bash, bashScopes);
    }

    return result;
}

/** 包裹 Bash 工具，使其只执行落在 allowedScopes 内的命令；越界命令返回错误结果而非抛错。 */
function wrapBashWithScope(bashTool: ToolSet[string], allowedScopes: string[]): ToolSet[string] {
    const original = bashTool as { execute?: (input: unknown, options: unknown) => unknown };
    if (typeof original.execute !== 'function') return bashTool;
    const originalExecute = original.execute.bind(original);
    return {
        ...bashTool,
        execute: async (input: unknown, options: unknown) => {
            const command =
                typeof input === 'object' && input !== null && 'command' in input
                    ? String((input as { command: unknown }).command ?? '')
                    : '';
            const allowed = allowedScopes.some((p) => matchesCommandScope(command, p));
            if (!allowed) {
                log.warn('命令超出技能允许的命令范围，已拒绝', { command, allowedScopes });
                return {
                    success: false,
                    error: `该命令不在当前技能允许的命令范围内（仅允许：${allowedScopes.join(', ')}）`
                };
            }
            return originalExecute(input, options);
        }
    } as ToolSet[string];
}
