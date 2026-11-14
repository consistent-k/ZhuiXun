import os from 'node:os';
import path from 'node:path';

import type { PermissionRuleSet, PolicyDecision } from '@zhuixun/shared';

import { matchesHost } from '@/platform/web/url-policy';

/**
 * 声明式权限规则：解析、匹配与判定（纯函数，无 IO）。
 *
 * 语法对齐 Claude Code：`Tool` 或 `Tool(specifier)`。
 * - `Bash(git push:*)`：命令头前缀（按空白切词，程序名按基名比较）；复合命令按 shell 操作符切段逐段匹配。
 * - `Read(glob)` / `Write(glob)` / `Edit(glob)`：Node 原生 `path.matchesGlob`；`~/` 展开为家目录、
 *   `./` 与其它相对模式相对会话工作目录、`**` 开头不锚定。Read 规则同时作用于 Grep / Glob / LS；
 *   Write 与 Edit 规则互通（二者都是文件写入）。
 * - `WebFetch(domain:example.com)`：与 url-policy 同一套 host 匹配（`*.example.com` 含自身）。
 * - `MCP(github_*)`：按运行时工具名 glob 匹配，仅作用于 MCP 工具；裸 `MCP` 匹配全部 MCP 工具。
 * - 其它工具名：精确匹配，不接受 specifier。
 */

export interface ParsedRule {
    /** 规则原文（已 trim） */
    raw: string;
    tool: string;
    spec?: string;
}

/** 规则所需的运行上下文。 */
export interface PolicyContext {
    /** 会话工作目录：相对路径与 `./` 模式按它解析 */
    cwd?: string;
    /** 判定某工具名是否为 MCP 工具（运行时 `server_tool` 名） */
    isMcpTool?: (toolName: string) => boolean;
}

/** 编译后的规则集（已剔除非法规则）。 */
export interface CompiledRuleSet {
    deny: ParsedRule[];
    ask: ParsedRule[];
    allow: ParsedRule[];
}

export const RULE_KINDS = ['deny', 'ask', 'allow'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** 单组规则条数上限，防手改文件塞入海量规则拖慢每次工具调用。 */
export const MAX_RULES_PER_KIND = 200;

const RULE_RE = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$/s;
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit']);
/** 受 Read 规则约束的工具：它们都能读到文件内容或目录结构。 */
const READ_LIKE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const WRITE_LIKE_TOOLS = new Set(['Write', 'Edit']);
/** 复合命令切段：控制操作符、管道、换行、命令替换与子 shell 括号。 */
const SEGMENT_SPLIT_RE = /&&|\|\||[;|&\n`()]|\$\(/;
/** 不改变语义的前缀包装命令：匹配时跳过它们，避免 `env rm x` / `nohup rm x` 绕过 `Bash(rm:*)`。 */
const WRAPPER_COMMANDS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'sudo', 'doas']);
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** allow 规则不放行带重定向 / 命令替换的命令：这些写法能在「安全命令头」之外产生副作用。 */
const UNSAFE_FOR_ALLOW_RE = /[<>`]|\$\(/;

/**
 * 解析并校验一条规则；非法时抛出带中文说明的 Error（路由据此返回 400）。
 */
export function parsePermissionRule(input: string): ParsedRule {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw) throw new Error('规则不能为空');
    if (raw.length > 500) throw new Error('规则过长（上限 500 字符）');
    const match = RULE_RE.exec(raw);
    if (!match) throw new Error(`规则格式不合法：${raw}（应为 Tool 或 Tool(参数)）`);
    const tool = match[1];
    const spec = match[2]?.trim();
    if (match[2] !== undefined && !spec) throw new Error(`规则参数不能为空：${raw}`);
    if (spec === undefined) return { raw, tool };

    if (tool === 'Bash') {
        if (!commandTokens(spec.replace(/:\*$/, '')).length && spec !== '*') {
            throw new Error(`Bash 规则参数不合法：${raw}`);
        }
    } else if (tool === 'WebFetch') {
        if (!/^domain:[^\s/]+$/.test(spec)) throw new Error(`WebFetch 规则应为 WebFetch(domain:example.com)：${raw}`);
    } else if (!PATH_TOOLS.has(tool) && tool !== 'MCP') {
        throw new Error(`${tool} 规则不支持参数，请写成 ${tool}：${raw}`);
    }
    return { raw, tool, spec };
}

/** 编译一组原始规则：非法规则跳过并记录在 invalid（不 fail-open，也不让整份规则失效）。 */
export function compileRuleSet(
    rules: Partial<PermissionRuleSet> | undefined,
    label: string,
    invalid: string[]
): CompiledRuleSet {
    const out: CompiledRuleSet = { deny: [], ask: [], allow: [] };
    for (const kind of RULE_KINDS) {
        const list = Array.isArray(rules?.[kind]) ? rules[kind] : [];
        for (const item of list.slice(0, MAX_RULES_PER_KIND)) {
            try {
                out[kind].push(parsePermissionRule(item));
            } catch {
                invalid.push(`${label}: ${String(item)}`);
            }
        }
    }
    return out;
}

/**
 * 规整用户提交的规则集：逐条校验（任一非法即抛出）、trim、去重、限长。
 */
export function normalizeRuleSet(input: Partial<PermissionRuleSet>): PermissionRuleSet {
    const out: PermissionRuleSet = { deny: [], ask: [], allow: [] };
    for (const kind of RULE_KINDS) {
        const list = input[kind] ?? [];
        if (!Array.isArray(list)) throw new Error(`${kind} 必须是字符串数组`);
        if (list.length > MAX_RULES_PER_KIND) throw new Error(`${kind} 规则超过上限 ${MAX_RULES_PER_KIND} 条`);
        for (const item of list) {
            const { raw } = parsePermissionRule(item);
            if (!out[kind].includes(raw)) out[kind].push(raw);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Bash 匹配
// ---------------------------------------------------------------------------

/** 切词并去掉引号；跳过前导环境变量赋值与包装命令（及紧随其后的 `-flag`）。 */
function commandTokens(segment: string): string[] {
    const tokens = segment
        .trim()
        .split(/\s+/)
        .map((t) => t.replace(/^["']+|["']+$/g, ''))
        .filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
        if (ENV_ASSIGN_RE.test(tokens[i])) {
            i++;
        } else if (WRAPPER_COMMANDS.has(basename(tokens[i]))) {
            i++;
            while (i < tokens.length && tokens[i].startsWith('-')) i++;
        } else {
            break;
        }
    }
    return tokens.slice(i);
}

function basename(program: string): string {
    return program.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
}

/** 把复合命令切成可独立匹配的段（含命令替换 / 子 shell 内部）。 */
export function commandSegments(command: string): string[] {
    return command
        .split(SEGMENT_SPLIT_RE)
        .map((s) => s.trim())
        .filter(Boolean);
}

/** 单段命令是否命中 Bash 规则参数（命令头前缀；程序名按基名、大小写不敏感）。 */
function segmentMatches(segment: string, spec: string | undefined): boolean {
    if (spec === undefined || spec === '*') return true;
    const want = commandTokens(spec.replace(/:\*$/, ''));
    const have = commandTokens(segment);
    if (want.length === 0 || have.length < want.length) return false;
    if (basename(have[0]) !== basename(want[0])) return false;
    return want.slice(1).every((token, idx) => have[idx + 1] === token);
}

// ---------------------------------------------------------------------------
// 路径匹配
// ---------------------------------------------------------------------------

function toSlash(p: string): string {
    return p.replace(/\\/g, '/');
}

/** 把规则里的 glob 规整成可与绝对路径比较的形态。 */
function expandGlob(spec: string, ctx: PolicyContext): string {
    if (spec === '~' || spec.startsWith('~/')) return toSlash(path.join(os.homedir(), spec.slice(1)));
    if (spec.startsWith('**') || path.isAbsolute(spec)) return toSlash(spec);
    const base = ctx.cwd ?? process.cwd();
    return toSlash(path.join(base, spec));
}

/** 解析工具入参里的目标路径为绝对路径（相对路径按会话工作目录）。 */
export function resolveTarget(raw: string, ctx: PolicyContext): string {
    const trimmed = raw.trim();
    if (trimmed === '~' || trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(1));
    return path.resolve(ctx.cwd ?? process.cwd(), trimmed || '.');
}

function globMatches(target: string, spec: string, ctx: PolicyContext, directory: boolean): boolean {
    const pattern = expandGlob(spec, ctx);
    const abs = toSlash(target);
    try {
        if (path.posix.matchesGlob(abs, pattern)) return true;
        // 目录类工具（Grep/Glob/LS）：目录本身落在 `dir/**` 规则内也算命中，防止列目录/检索绕过
        return directory && path.posix.matchesGlob(`${abs.replace(/\/$/, '')}/__probe__`, pattern);
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// 工具入参
// ---------------------------------------------------------------------------

function field(input: unknown, key: string): string | undefined {
    if (typeof input !== 'object' || input === null) return undefined;
    const value = (input as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
}

/**
 * 文件类工具的目标路径字段：Edit 用 `file_path`，bash-tool 的 Read / Write 用 `path`。
 * Grep / Glob 的 path 可缺省（默认工作目录）。
 */
export function toolPath(toolName: string, input: unknown): string | undefined {
    const raw = field(input, 'file_path') ?? field(input, 'path');
    if (raw !== undefined) return raw;
    return toolName === 'Grep' || toolName === 'Glob' ? '.' : undefined;
}

/** 审计 / 试算展示用的入参摘要：只取判定对象（命令 / 路径 / URL），不落正文等可能含敏感个人信息的字段。 */
export function inputSubject(toolName: string, input: unknown): string {
    if (toolName === 'Bash') return field(input, 'command') ?? '';
    if (toolName === 'WebFetch') return field(input, 'url') ?? '';
    return toolPath(toolName, input) ?? '';
}

function hostOf(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
        return new URL(raw).hostname.toLowerCase().replace(/\.+$/, '');
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

type Mode = 'restrict' | 'allow';

/**
 * 单条规则是否命中一次工具调用。
 * mode=restrict（deny/ask）：Bash 任一段命中即算；mode=allow：Bash 必须不含重定向/命令替换且**每段**都命中。
 */
export function ruleMatches(
    rule: ParsedRule,
    toolName: string,
    input: unknown,
    ctx: PolicyContext,
    mode: Mode
): boolean {
    if (rule.tool === 'MCP') {
        if (!ctx.isMcpTool?.(toolName)) return false;
        return rule.spec === undefined || path.posix.matchesGlob(toolName, rule.spec);
    }
    if (rule.tool === 'Bash') {
        if (toolName !== 'Bash') return false;
        const command = field(input, 'command') ?? '';
        const segments = commandSegments(command);
        if (segments.length === 0) return false;
        if (mode === 'restrict') return segments.some((seg) => segmentMatches(seg, rule.spec));
        return !UNSAFE_FOR_ALLOW_RE.test(command) && segments.every((seg) => segmentMatches(seg, rule.spec));
    }
    if (rule.tool === 'WebFetch') {
        if (toolName !== 'WebFetch') return false;
        if (rule.spec === undefined) return true;
        const host = hostOf(field(input, 'url'));
        return !!host && matchesHost(host, rule.spec.slice('domain:'.length));
    }
    if (rule.tool === 'Read' || rule.tool === 'Write' || rule.tool === 'Edit') {
        const family = rule.tool === 'Read' ? READ_LIKE_TOOLS : WRITE_LIKE_TOOLS;
        if (!family.has(toolName)) return false;
        if (rule.spec === undefined) return true;
        const raw = toolPath(toolName, input);
        if (raw === undefined) return false;
        return globMatches(resolveTarget(raw, ctx), rule.spec, ctx, toolName !== 'Read' && rule.tool === 'Read');
    }
    return rule.spec === undefined && rule.tool === toolName;
}

function sourceLabel(source: 'baseline' | 'user'): string {
    return source === 'baseline' ? '团队基线' : '用户规则';
}

/** 策略快照：基线 + 用户规则 + 基线是否损坏。 */
export interface PolicySnapshot {
    baseline: CompiledRuleSet;
    user: CompiledRuleSet;
    /** 外部基线损坏：所有工具降级为需确认，且不回落内置基线 */
    baselineInvalid?: boolean;
}

/** 应用数据目录字面量：Bash 命令涉及它一律需确认（硬底线，保护 hooks.json / 权限文件本身）。 */
const APP_DATA_MARKER = '.zhuixun';

/**
 * 按「deny → 硬底线 → ask → allow → none」取第一个命中。
 * deny 先于硬底线：同时命中时取更严格的拒绝。
 */
export function evaluateRules(
    snapshot: PolicySnapshot,
    toolName: string,
    input: unknown,
    ctx: PolicyContext
): PolicyDecision {
    const layers: Array<['baseline' | 'user', CompiledRuleSet]> = [
        ['baseline', snapshot.baseline],
        ['user', snapshot.user]
    ];
    const find = (kind: RuleKind, mode: Mode) => {
        for (const [source, set] of layers) {
            const hit = set[kind].find((rule) => ruleMatches(rule, toolName, input, ctx, mode));
            if (hit) return { rule: hit.raw, source };
        }
        return undefined;
    };

    const deny = find('deny', 'restrict');
    if (deny) {
        return {
            decision: 'deny',
            ...deny,
            reason: `被权限规则 ${deny.rule} 拒绝（${sourceLabel(deny.source)}）`
        };
    }
    if (toolName === 'Bash' && (field(input, 'command') ?? '').includes(APP_DATA_MARKER)) {
        return {
            decision: 'ask',
            rule: 'app-data-dir',
            source: 'floor',
            reason: '命令涉及应用数据目录 ~/.zhuixun，需要确认'
        };
    }
    if (snapshot.baselineInvalid) {
        return {
            decision: 'ask',
            rule: 'baseline-invalid',
            source: 'baseline',
            reason: '团队权限基线文件损坏，所有工具调用需确认'
        };
    }
    const ask = find('ask', 'restrict');
    if (ask)
        return { decision: 'ask', ...ask, reason: `命中权限规则 ${ask.rule}（${sourceLabel(ask.source)}），需要确认` };
    const allow = find('allow', 'allow');
    if (allow)
        return { decision: 'allow', ...allow, reason: `命中权限规则 ${allow.rule}（${sourceLabel(allow.source)}）` };
    return { decision: 'none' };
}

/**
 * 可下推给 ripgrep 的 Read-deny 排除 glob：只取不锚定的 `**` 规则（rg 的 glob 相对检索根匹配，
 * 绝对 / `~` 规则由路径判定直接拦截）。返回值为 `!` + 规则 glob，追加在用户 glob 之后。
 */
export function readDenyExcludeGlobs(snapshot: PolicySnapshot): string[] {
    const out: string[] = [];
    for (const set of [snapshot.baseline, snapshot.user]) {
        for (const rule of set.deny) {
            if (rule.tool === 'Read' && rule.spec?.startsWith('**')) out.push(`!${rule.spec}`);
        }
    }
    return [...new Set(out)];
}
