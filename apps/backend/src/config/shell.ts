/**
 * 本地 shell 工具（Bash/Read/Write）的配置：工作区/审计路径、shell 选择、超时与输出上限。
 * 收口 core/tools/shell-tools.ts 里的散落常量与 env 读取。
 *
 * 注意：workspace 落在 os.tmpdir() 下，**不在 ZHUIXUN_HOME**——它是可丢弃的临时执行区。
 * 审计日志则需长期保留（危险模式下是唯一事后追溯手段），路径见 config/paths.ts 的 auditFile()。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optional } from './env';

/** shell 的工作目录（进程级固定，跨请求复用，避免每次请求堆临时目录）。 */
export const WORKSPACE_DIR = path.join(os.tmpdir(), 'zhuixun-workspace');

/** 单条命令默认超时。 */
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
/** stdout/stderr 各自的累积上限，超过就丢弃后续输出。 */
export const MAX_STREAM_BYTES = 10 * 1024 * 1024;
/** 传给 bash-tool 的输出截断长度，30KB（模型实际看到的上限）。 */
export const MAX_OUTPUT_LENGTH = 30_000;
/** 超时终止进程组后，等待 'close' 的宽限时间。 */
export const KILL_GRACE_MS = 2_000;

/**
 * 选择 shell。刻意不跟随 `process.env.SHELL`：工具名叫 Bash，模型会按 bash 语法写命令，
 * 而 zsh/fish 的差异（尤其 glob 与 `set -e` 行为）会使同一条命令时而正常、时而出错。
 * 需要别的 shell 时用 `ZHUIXUN_SHELL` 显式指定。
 *
 * Windows 下的探测（pwsh 7 → Windows PowerShell 5.x → cmd）需要起进程，放在
 * core/tools/windows-shell.ts；这里只做纯配置层的部分。
 */
export type ShellKind = 'posix' | 'powershell' | 'cmd';

export interface ShellSpec {
    /** 可执行文件（绝对路径或 PATH 上的名字）。 */
    bin: string;
    /** 方言：决定参数拼法、命令适配与给模型的语法提示。 */
    kind: ShellKind;
    /** PowerShell 主版本（5 = Windows PowerShell，≥7 = pwsh）；非 PowerShell 或探测失败为 undefined。 */
    psMajor?: number;
}

/** `ZHUIXUN_SHELL` 显式指定的 shell（未设置为 undefined）。 */
export function shellOverride(): string | undefined {
    return optional('ZHUIXUN_SHELL');
}

/**
 * 按可执行文件名推断方言。Windows 下 `ZHUIXUN_SHELL` 可以指向 pwsh / powershell / cmd，
 * 也可以指向 Git Bash 之类的 POSIX shell；用 win32.basename 同时兼容 `\` 与 `/` 分隔。
 */
export function inferShellKind(bin: string): ShellKind {
    const name = path.win32
        .basename(bin)
        .toLowerCase()
        .replace(/\.exe$/, '');
    if (name === 'pwsh' || name === 'powershell') return 'powershell';
    if (name === 'cmd') return 'cmd';
    return 'posix';
}

/** 非 Windows 平台的 shell：override → /bin/bash → /bin/sh。 */
export function resolvePosixShell(): ShellSpec {
    const override = shellOverride();
    if (override) return { bin: override, kind: 'posix' };
    if (fs.existsSync('/bin/bash')) return { bin: '/bin/bash', kind: 'posix' };
    return { bin: '/bin/sh', kind: 'posix' };
}

/** 单条命令超时；`ZHUIXUN_SHELL_TIMEOUT_MS` 可覆盖，非法值告警并回落默认。 */
export function resolveShellTimeoutMs(): number {
    const raw = optional('ZHUIXUN_SHELL_TIMEOUT_MS');
    if (!raw) return DEFAULT_SHELL_TIMEOUT_MS;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    console.warn('[ShellConfig] 忽略无效的 ZHUIXUN_SHELL_TIMEOUT_MS', {
        value: raw,
        fallbackMs: DEFAULT_SHELL_TIMEOUT_MS
    });
    return DEFAULT_SHELL_TIMEOUT_MS;
}
