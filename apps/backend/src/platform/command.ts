/**
 * 命令头解析（纯函数，无 IO / 无依赖）。
 *
 * 用于「命令审批记忆」：把模型给出的一条 Bash 命令解析成可匹配、可记忆的**命令头**
 * （程序名 + 子命令链，如 `git status`、`npm run build`），并判定它是否安全到可以被记住。
 *
 * 安全底线（宁可多问，绝不误放行）：
 * - 含 shell 操作符 / 重定向 / 命令替换（`&&`、`||`、`|`、`;`、`<`、`>`、`` ` ``、`$(`、换行）
 *   的复合命令一律判为不可记忆——记住 `git status` 绝不能顺带放行 `git status && rm -rf x`。
 * - 危险命令头（rm/dd/mkfs/shutdown/sudo/chmod/chown 等）默认拒绝记忆：用户仍可每次手动
 *   批准、执行层从不拦截（守住 shell-tools 的「审计 + 超时」底线），只是不提供「免确认」便利。
 * - 无法安全解析（首个 token 不是规整的程序名等）时判为不可记忆。
 */

/** shell 复合 / 重定向 / 命令替换标志：命中即不可记忆。 */
const SHELL_OPERATOR_RE = /[&|;<>`\n]|\$\(/;

/** 规整程序名：允许字母数字、`._-`、路径分隔符（覆盖 `git`、`node`、`/usr/bin/git`）。 */
const PROGRAM_RE = /^[A-Za-z0-9._/-]+$/;

/** 子命令 token：纯 kebab 单词（`status`、`run`、`build`），不含 `-` 前缀 / 路径 / glob。 */
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]*$/i;

/** 前导环境变量赋值 token（`FOO=bar cmd`），提取程序名时跳过。 */
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 命令头最多纳入的子命令层级，避免记住过长的具体调用。 */
const MAX_SUBCOMMANDS = 2;

/**
 * 危险命令头基名：默认拒绝记忆。以命令的**基名**（去掉路径）匹配；`mkfs.*` 按前缀命中。
 * 执行不受影响，仅「记住免确认」被拒绝。
 */
const DANGEROUS_BASENAMES = new Set([
    'rm',
    'rmdir',
    'dd',
    'mkfs',
    'fdisk',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'sudo',
    'su',
    'chmod',
    'chown',
    'chgrp',
    'kill',
    'killall',
    'pkill',
    'mv'
]);

/** 命令头解析结果。 */
export interface CommandHeadResult {
    /** 是否可被记忆 / 参与自动放行匹配。 */
    safe: boolean;
    /** 归一化命令头（如 `git status`）；解析成功时始终给出，供 UI 预览与匹配。 */
    head?: string;
    /** 不可记忆的原因。 */
    reason?: 'compound' | 'unsafe' | 'denylisted';
}

/** 取程序基名（去路径），用于危险命令名判定。 */
function basename(program: string): string {
    const idx = program.lastIndexOf('/');
    return idx >= 0 ? program.slice(idx + 1) : program;
}

function isDangerous(program: string): boolean {
    const base = basename(program).toLowerCase();
    return DANGEROUS_BASENAMES.has(base) || base.startsWith('mkfs');
}

/**
 * 解析命令头。
 *
 * @param command 模型给出的原始 Bash 命令字符串
 * @returns 解析结果：`safe` 为真时 `head` 可用于记忆与匹配；否则 `reason` 说明原因
 */
export function deriveCommandHead(command: string): CommandHeadResult {
    const trimmed = command.trim();
    if (!trimmed) return { safe: false, reason: 'unsafe' };
    if (SHELL_OPERATOR_RE.test(trimmed)) return { safe: false, reason: 'compound' };

    // 引号会让「按空白切词」不可靠（可能把带空格的参数切碎），保守判为不可记忆。
    if (/["']/.test(trimmed)) return { safe: false, reason: 'unsafe' };

    const tokens = trimmed.split(/\s+/);
    let i = 0;
    // 跳过前导环境变量赋值
    while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i])) i++;
    const program = tokens[i];
    if (!program || !PROGRAM_RE.test(program)) return { safe: false, reason: 'unsafe' };

    // 收集紧随其后的纯单词子命令（遇到 `-flag` / 路径 / 参数即停）
    const parts = [program];
    for (let j = i + 1; j < tokens.length && parts.length <= MAX_SUBCOMMANDS; j++) {
        if (SUBCOMMAND_RE.test(tokens[j])) {
            parts.push(tokens[j]);
        } else {
            break;
        }
    }
    const head = parts.join(' ');

    if (isDangerous(program)) return { safe: false, head, reason: 'denylisted' };
    return { safe: true, head };
}

/**
 * 判定一条命令是否落在给定的命令级 scope 模式内（用于 allowed-tools 的 `Bash(git log:*)`）。
 *
 * 模式语法（对齐 Claude Code 风格）：
 * - `git` / `git:*`      → 允许以 `git` 开头的命令
 * - `git log` / `git log:*` → 允许以 `git log` 开头的命令
 * 匹配基于安全解析出的命令头（已拒绝复合/重定向/危险命令），因此 fail-safe：
 * 命令本身解析不安全时一律不匹配。
 */
export function matchesCommandScope(command: string, pattern: string): boolean {
    const parsed = deriveCommandHead(command);
    // 复合/重定向/不可解析命令没有可信命令头 → 不匹配（仍走正常审批）。
    // denylisted 命令仍有 head，可参与匹配——匹配只决定「是否在技能白名单内」，不改变执行与审批。
    if (!parsed.head) return false;
    const head = parsed.head;
    // 规整 pattern：去掉结尾的 `:*`，按空白归一
    const normalized = pattern.trim().replace(/:\*$/, '').replace(/\s+/g, ' ');
    if (!normalized) return false;
    return head === normalized || head.startsWith(`${normalized} `);
}
