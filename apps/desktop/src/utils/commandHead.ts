/**
 * 前端命令头预览解析（**仅用于审批卡展示**，后端 `command-head.ts` 为权威判定）。
 *
 * 与后端逻辑保持一致：识别复合 / 重定向命令、危险命令头，提取程序名 + 子命令链作为命令头。
 * 项目无前后端共享包，这里是有意的小范围重复；改动匹配规则时两处需同步。
 */

const SHELL_OPERATOR_RE = /[&|;<>`\n]|\$\(/;
const PROGRAM_RE = /^[A-Za-z0-9._/-]+$/;
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]*$/i;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_SUBCOMMANDS = 2;

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

/** 命令头预览结果 */
export interface CommandHeadPreview {
    /** 是否可被记忆 */
    safe: boolean;
    /** 归一化命令头（如 `git status`） */
    head?: string;
    /** 不可记忆的原因 */
    reason?: 'compound' | 'unsafe' | 'denylisted';
}

function basename(program: string): string {
    const idx = program.lastIndexOf('/');
    return idx >= 0 ? program.slice(idx + 1) : program;
}

function isDangerous(program: string): boolean {
    const base = basename(program).toLowerCase();
    return DANGEROUS_BASENAMES.has(base) || base.startsWith('mkfs');
}

/** 解析命令头（预览用）。 */
export function previewCommandHead(command: string): CommandHeadPreview {
    const trimmed = command.trim();
    if (!trimmed) return { safe: false, reason: 'unsafe' };
    if (SHELL_OPERATOR_RE.test(trimmed)) return { safe: false, reason: 'compound' };
    if (/["']/.test(trimmed)) return { safe: false, reason: 'unsafe' };

    const tokens = trimmed.split(/\s+/);
    let i = 0;
    while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i])) i++;
    const program = tokens[i];
    if (!program || !PROGRAM_RE.test(program)) return { safe: false, reason: 'unsafe' };

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
