import type { CommandExpandResult } from '@zhuixun/shared';

/**
 * slash 命令解析与模板展开（纯函数，无 IO）。
 *
 * 命令宏只是提示词模板：不支持 Claude Code 的 `` !`cmd` `` 内嵌执行与 `@file` 引用，不引入新的执行面。
 */

/** 命令名：小写字母 / 数字 / 连字符，1–32 位（防路径穿越，与技能 id 同口径）。 */
export const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 内置命令（前端本地处理，不走模板展开）；用户命令不得同名。 */
export const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string; argumentHint?: string }> = [
    { name: 'new', description: '新建对话' },
    { name: 'help', description: '列出所有可用命令' },
    { name: 'compact', description: '手动压缩当前对话上下文', argumentHint: '[需要保留的要点]' }
];

export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(BUILTIN_COMMANDS.map((c) => c.name));

/** 解析首行 `/name args`；不是命令形态（如 `/path/to/file`、`/ 空格`）返回 null。 */
export function parseCommandInvocation(text: string): { name: string; args: string } | null {
    const match = /^\/([a-z0-9][a-z0-9-]{0,31})(?=\s|$)([\s\S]*)$/.exec(text.trimStart());
    if (!match) return null;
    return { name: match[1], args: match[2].trim() };
}

/** 按空白切分参数，支持单 / 双引号包裹含空格的参数。 */
export function splitArgs(args: string): string[] {
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(args))) out.push(match[1] ?? match[2] ?? match[3]);
    return out;
}

/**
 * 展开模板：`$ARGUMENTS` 为全部参数原文，`$1`…`$9` 为按位参数（缺省为空串）。
 * 模板里没有任何占位符且带了参数时，把参数追加到末尾，避免用户输入被静默丢弃。
 */
export function expandTemplate(body: string, args: string): string {
    const positional = splitArgs(args);
    let used = false;
    const expanded = body.replace(/\$ARGUMENTS|\$([1-9])/g, (_m, idx: string | undefined) => {
        used = true;
        return idx ? (positional[Number(idx) - 1] ?? '') : args;
    });
    if (!used && args) return `${expanded.trimEnd()}\n\n${args}`;
    return expanded;
}

/** 解析 + 查找 + 展开；查找函数返回模板正文，未命中返回 undefined。 */
export async function expandCommandText(
    text: string,
    lookup: (name: string) => Promise<string | undefined>
): Promise<CommandExpandResult> {
    const invocation = parseCommandInvocation(text);
    if (!invocation || BUILTIN_COMMAND_NAMES.has(invocation.name)) return { matched: false };
    const body = await lookup(invocation.name);
    if (body === undefined) return { matched: false };
    return { matched: true, ...invocation, expanded: expandTemplate(body, invocation.args) };
}
