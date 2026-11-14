import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ToolSet } from 'ai';
import { createBashTool, type CommandResult, type Sandbox } from 'bash-tool';
import dayjs from 'dayjs';

import { paths } from '@/config/paths';
import {
    KILL_GRACE_MS,
    MAX_OUTPUT_LENGTH,
    MAX_STREAM_BYTES,
    WORKSPACE_DIR,
    resolvePosixShell,
    resolveShellTimeoutMs,
    type ShellSpec
} from '@/config/shell';
import type { CheckpointRecorder } from '@/modules/conversations';
import { createLogger } from '@/platform/logging/index';

import { createEditSearchTools } from './edit-search-tools';
import { hostOs, type HostOs } from './host-os';
import { isSeedableSkillResource } from './skill-resources';
import {
    buildWindowsInvocation,
    createWindowsDecoder,
    resolveWindowsShell,
    type ShellInvocation
} from './windows-shell';

const log = createLogger('Shell');

/**
 * 本地真实 shell 工具（Bash / Read / Write）。
 *
 * 设计要点
 * --------
 * - 这是**真实**的 shell：`spawn` 一个真实 shell，模型可执行 grep/node/任何命令。
 *   不是 just-bash 那种模拟环境（它无法运行 node，`grep` 也是自行实现的子集）。
 * - 复用 bash-tool 的工具外壳（schema、描述生成、输出截断），只把执行层换成
 *   `LocalShellSandbox`。传入 `sandbox` 后 bash-tool 完全不会涉及 just-bash。
 * - 按用户决策，底线只有**审计日志 + 执行超时**，不做任何命令拦截/白名单。
 *   模型可以读任意文件、写任意文件、联网。这是有意接受的取舍。
 *
 * 为什么工作目录用固定的临时目录而不是技能目录本身
 * ------------------------------------------------
 * 技能目录是源码/安装产物的一部分，让模型在里面写文件会污染安装目录（且打包
 * 形态下在 .app 包内）。因此把技能资源**拷入** workspace，模型的一切读写都发生在
 * 那里；技能目录保持只读。
 */

/** 超时退出码，沿用 coreutils `timeout` 的约定。 */
const EXIT_TIMEOUT = 124;
/** 命令无法执行（shell 都起不来）。 */
const EXIT_SPAWN_FAILED = 127;

/**
 * 工具说明。用 `promptOptions.toolPrompt` 传进去，有两个作用：
 * 1. 跳过 bash-tool 的 `discoverAvailableTools`（它会真的执行 `ls /usr/bin ...`，既慢又把
 *    macOS 的整个 /usr/bin 列表写入工具描述）；
 * 2. 明确说明「这是真实 shell、node 是真实 node」——否则模型会按 Claude Code 的直觉推断。
 *
 * 工作目录和 Available files 清单由 bash-tool 自动拼在本段之前，不用重复写。
 * 项目模式（cwd 是用户真实文件夹）不 seed 技能文档、没有 Available files，结尾说法需随之切换；
 * 超时取运行时配置（`ZHUIXUN_SHELL_TIMEOUT_MS` 可覆盖），不写死。
 */
/**
 * 各方言的语法提示。Windows 下工具虽叫 Bash，实际解释器可能是 PowerShell 5.x / 7.x 或 cmd：
 * 未明确说明时模型会照 bash 习惯写 free/grep/&&，连续失败（Windows 实测日志即如此）。
 * POSIX 下也要说明是 macOS 还是 Linux：mac 实测模型先试 `free -h`、`/proc/meminfo` 才换 `sysctl`。
 */
function shellSyntaxLines(shell: ShellSpec, host: HostOs, timeoutLine: string): string[] {
    const nodeLine = '- `node` 是真实的 Node.js，可以直接 `node scripts/xxx.js`、`node -e "..."`；';
    const hostLine = `操作系统：**${host.label}**。`;
    if (shell.kind === 'powershell') {
        const modern = (shell.psMajor ?? 0) >= 7;
        const name = shell.psMajor
            ? `PowerShell ${shell.psMajor}${modern ? '' : '（Windows PowerShell）'}`
            : 'PowerShell（版本未知，按 5.1 兼容语法写）';
        return [
            `这是一个运行在用户 **Windows** 本机上的**真实** shell，解释器是 **${name}**（不是 bash）。`,
            hostLine,
            '',
            modern
                ? '- 写 PowerShell 语法；支持 `&&` / `||`，也可用 `;` 分隔多条命令；'
                : '- 写 PowerShell 语法；**不支持 `&&` / `||`**，多条命令用 `;` 分隔，「前一条成功才执行」用 `if ($?) { ... }`；',
            '- 没有 free / grep / sed / awk / head / tail 等 POSIX 命令：用 Get-CimInstance、Get-ChildItem、Get-Content、Select-String、Select-Object -First N 等替代；',
            '- 系统信息示例：内存 `Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory`，CPU `Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores`；',
            `${nodeLine}跨平台逻辑优先用 node 实现；`,
            timeoutLine,
            `- stdout/stderr 超过 ${MAX_OUTPUT_LENGTH} 字符会被截断；用 Select-Object -First / Select-String 收窄输出。`,
            ''
        ];
    }
    if (shell.kind === 'cmd') {
        return [
            '这是一个运行在用户 **Windows** 本机上的**真实** shell，解释器是 **cmd.exe**（不是 bash，也没有 PowerShell 可用）。',
            hostLine,
            '',
            '- 写 cmd 批处理语法：`&&` / `||` / `&` 连接命令，变量写 `%VAR%`；',
            '- 没有 POSIX 命令：用 dir / type / findstr / where 等替代；',
            '- 系统信息示例：内存 `systeminfo | findstr /c:"Total Physical Memory" /c:"物理内存总量"`；',
            `${nodeLine}复杂逻辑优先用 node 实现；`,
            timeoutLine,
            `- stdout/stderr 超过 ${MAX_OUTPUT_LENGTH} 字符会被截断；用 findstr 收窄输出。`,
            ''
        ];
    }
    return [
        process.platform === 'win32'
            ? `这是一个运行在用户 **Windows** 本机上的**真实** POSIX shell（${shell.bin}），Windows 路径可写成 C:/xxx 形式。`
            : '这是一个运行在用户本机上的**真实** shell（不是模拟沙箱）。',
        hostLine,
        '',
        nodeLine,
        '- 可用常见 POSIX 命令：grep / sed / awk / find / cat / head / tail / wc / sort / uniq / cut / tr 等；',
        ...posixHostLines(host.family),
        timeoutLine,
        `- stdout/stderr 超过 ${MAX_OUTPUT_LENGTH} 字符会被截断；用 head/tail/grep 收窄输出，不要 cat 整个大文件。`,
        ''
    ];
}

/** POSIX shell 下按宿主系统给出的命令差异提示（mac 与 Linux 查系统信息的命令完全不同）。 */
function posixHostLines(family: HostOs['family']): string[] {
    if (family === 'macos') {
        return [
            "- 这是 macOS（BSD 用户态）：**没有** free、/proc、lscpu，sed -i 需写成 `sed -i ''`；不要假设装了 jq / yq / rg，解析 JSON 优先用 `node -e`；",
            '- 系统信息示例：内存总量 `sysctl -n hw.memsize`（字节），CPU `sysctl -n machdep.cpu.brand_string hw.ncpu`，系统版本 `sw_vers -productVersion`，内存占用 `vm_stat`，磁盘 `df -h /`；'
        ];
    }
    if (family === 'linux') {
        return [
            '- 不要假设装了 jq / yq / rg，解析 JSON 优先用 `node -e`；',
            '- 系统信息示例：内存 `free -h`，CPU `nproc` / `lscpu | head -20`，系统版本 `cat /etc/os-release`，磁盘 `df -h /`；'
        ];
    }
    return ['- 不要假设装了 jq / yq / rg，解析 JSON 优先用 `node -e`；'];
}

/**
 * 隐私引导（所有方言通用）。完整硬件报告会带出序列号 / 硬件 UUID 等设备标识，命令输出会原样发给模型服务
 * 并写入会话记录；mac 实测模型为查内存执行了 `system_profiler SPHardwareDataType`，序列号、UDID 随之外发。
 */
const PRIVACY_LINE =
    '- 查询系统信息时只取回答所需的字段（如问内存就只查内存总量）：不要输出完整硬件报告——`system_profiler SPHardwareDataType`、`ioreg`、`systeminfo`、`Get-CimInstance Win32_BIOS`、`dmidecode` 等会带出序列号、硬件 UUID 等设备标识，命令输出会发送给模型服务并写入会话记录。确需此类命令时用 grep / Select-String / findstr 过滤出所需行。';

function buildShellToolPrompt(
    timeoutMs: number,
    shell: ShellSpec,
    mode: { projectDir: boolean; hasSkillDocs: boolean; additionalDirs?: string[] }
): string {
    const timeoutLine = `- 单条命令最长执行 ${Math.round(timeoutMs / 1000)} 秒，超时会被强制结束并返回退出码 124；`;
    const lines = shellSyntaxLines(shell, hostOs(), timeoutLine);
    // 插在各方言列表末尾的空行之前，与其它要点同一组
    lines.splice(lines.length - 1, 0, PRIVACY_LINE);
    if (mode.projectDir) {
        lines.push(
            '当前工作目录是用户的项目主目录（真实文件）：修改或删除已有文件前先确认用途，新产出优先写成新文件。'
        );
        if (mode.additionalDirs && mode.additionalDirs.length > 0) {
            lines.push(
                `该项目还包含以下附加目录，可用绝对路径直接访问：\n${mode.additionalDirs.map((d) => `  - ${d}`).join('\n')}`
            );
        }
    } else if (mode.hasSkillDocs) {
        lines.push(
            '上面列出的 Available files 是各技能的参考文档；技能自带的脚本等资源文件也在对应技能目录下，相对路径可直接使用。',
            '如果要生成文件，请写到当前目录下的新文件里，不要覆盖这些技能文件。'
        );
    } else {
        lines.push('当前工作目录是临时工作区；如果要生成文件，请写到当前目录下的新文件里。');
    }
    return lines.join('\n');
}

/**
 * bash-tool 生成的工具描述硬编码了 bash 措辞与 `ls -la` / `grep -r` / `cat` 示例，Windows 非 POSIX
 * shell 下会直接误导模型（`ls -la` 在 PowerShell 里就是参数错误）。改写首行并替换示例块；
 * 匹配不到（bash-tool 改版）时原样返回，toolPrompt 里的语法说明仍然生效。
 */
const WINDOWS_COMMON_OPERATIONS: Record<Exclude<ShellSpec['kind'], 'posix'>, string[]> = {
    powershell: [
        'Get-ChildItem -Force                       # List files with details',
        "Get-ChildItem -Recurse -Filter '*.md'      # Find files by pattern",
        "Select-String -Path .\\* -Pattern 'text'    # Search file contents",
        'Get-Content <file> -TotalCount 100         # View file contents'
    ],
    cmd: [
        'dir                       # List files with details',
        'dir /s /b *.md            # Find files by pattern',
        'findstr /s /i "text" *    # Search file contents',
        'type <file>               # View file contents'
    ]
};

function adaptBashDescription(description: string, kind: ShellSpec['kind']): string {
    if (kind === 'posix') return description;
    const shellName = kind === 'powershell' ? 'PowerShell' : 'cmd.exe';
    const ops = WINDOWS_COMMON_OPERATIONS[kind].map((line) => `  ${line}`).join('\n');
    return description
        .replace(
            'Execute bash commands in the sandbox environment.',
            `Execute ${shellName} commands on the user's Windows machine (the tool is named Bash, but the interpreter is ${shellName}).`
        )
        .replace(/Common operations:\n(?: {2}.*(?:\n|$))+/, `Common operations:\n${ops}\n`);
}

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

/**
 * 审计写入串行化：用一条 promise 链保证多行不会交错，且任何写入失败都不会
 * 冒泡成未处理的 rejection（审计不该影响命令执行本身）。
 */
let auditChain: Promise<void> = Promise.resolve();
let auditDirReady: Promise<void> | undefined;

function auditLog(entry: Record<string, unknown>): void {
    const line = `${JSON.stringify(entry)}\n`;
    auditChain = auditChain
        .then(async () => {
            auditDirReady ??= fsp.mkdir(paths.auditDir(), { recursive: true }).then(() => undefined);
            await auditDirReady;
            await fsp.appendFile(paths.auditFile(), line, 'utf8');
        })
        .catch((error: unknown) => {
            // 审计失败只告警，不能让模型的一次命令调用因此失败
            log.warn('审计日志写入失败', { err: error });
        });
}

/** 日志/审计里的命令预览：命令可能很长（甚至带文件内容），截断以避免日志过长。 */
function previewCommand(command: string, max = 300): string {
    const oneLine = command.replace(/\s+/g, ' ').trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…(${oneLine.length} 字符)`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 输出累积
// ---------------------------------------------------------------------------

interface StreamAccumulator {
    chunks: Buffer[];
    bytes: number;
    truncated: boolean;
}

function createAccumulator(): StreamAccumulator {
    return { chunks: [], bytes: 0, truncated: false };
}

/**
 * 累积输出，但**始终消费**数据流。
 *
 * 超过上限后继续 `push` 但丢弃内容：如果在这里停止监听，管道缓冲区会填满，
 * 子进程会被阻塞在 write 上直至超时——那比截断输出糟糕得多。
 */
function pushChunk(acc: StreamAccumulator, chunk: Buffer): void {
    if (acc.truncated) return;
    const remaining = MAX_STREAM_BYTES - acc.bytes;
    if (chunk.length <= remaining) {
        acc.chunks.push(chunk);
        acc.bytes += chunk.length;
        return;
    }
    if (remaining > 0) {
        acc.chunks.push(chunk.subarray(0, remaining));
        acc.bytes += remaining;
    }
    acc.truncated = true;
}

/** 输出解码器：posix 一律 UTF-8；Windows 由 createWindowsDecoder 按系统代码页回落。 */
type OutputDecoder = (buf: Buffer) => string;

const decodeUtf8: OutputDecoder = (buf) => buf.toString('utf8');

function finalizeStream(acc: StreamAccumulator, name: 'stdout' | 'stderr', decode: OutputDecoder): string {
    const text = decode(Buffer.concat(acc.chunks));
    return acc.truncated ? `${text}\n\n[${name} 累积超过 ${MAX_STREAM_BYTES / 1024 / 1024}MB，后续输出已丢弃]` : text;
}

// ---------------------------------------------------------------------------
// shell 选择与超时
// ---------------------------------------------------------------------------

/** 当前平台的 shell：Windows 经探测获取（进程级缓存），其余平台为纯配置。 */
export async function resolveShell(): Promise<ShellSpec> {
    return process.platform === 'win32' ? resolveWindowsShell() : resolvePosixShell();
}

/**
 * 终止**整个进程组**，而不只是 shell 本身。
 *
 * 由于以 `detached: true` 启动，子进程自成进程组组长，`process.kill(-pid)` 才能
 * 连带终止 `node xxx.js`、`sleep 300` 这类孙进程。用 exec 的 timeout 做不到这点——
 * 它只终止 shell，孙进程会变成孤儿继续运行。
 */
export function killProcessGroup(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
        // Windows 无进程组信号，child.kill 只终止 shell 本身；用 taskkill /T 连带终止子孙进程
        const taskkill = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        try {
            spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () =>
                child.kill('SIGKILL')
            );
        } catch {
            child.kill('SIGKILL');
        }
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        // 进程组可能已随 shell 退出而消失，退回终止单个进程（也可能已退出）
        try {
            child.kill('SIGKILL');
        } catch {
            /* 进程已退出，忽略 */
        }
    }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
    if (signal === 'SIGKILL') return 137;
    if (signal === 'SIGTERM') return 143;
    return signal ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Sandbox 实现
// ---------------------------------------------------------------------------

/**
 * bash-tool（tools/bash.js）会把每条命令拼成 `cd "<cwd>" && <command>` 再交给 sandbox。
 * Windows PowerShell 5.x 不支持 `&&`，整条脚本在解析阶段就报 ParserError，**任何命令都无法执行**；
 * cmd 的 `cd` 不带 `/d` 也无法切换盘符。spawn 时已经把 cwd 设成同一目录，这个前缀纯属冗余，
 * 非 POSIX shell 下直接剥离。
 */
const BASH_TOOL_CD_PREFIX = /^cd "[^"]*" && /;

function adaptCommandForShell(command: string, kind: ShellSpec['kind']): string {
    return kind === 'posix' ? command : command.replace(BASH_TOOL_CD_PREFIX, '');
}

export function buildInvocation(shell: ShellSpec, command: string): ShellInvocation {
    return process.platform === 'win32' ? buildWindowsInvocation(shell, command) : { args: ['-c', command] };
}

class LocalShellSandbox implements Sandbox {
    /**
     * @param cwd 命令执行的工作目录。默认临时 workspace；项目配置了工作目录时指向其主根。
     * @param shell 已解析好的 shell（Windows 下的探测在 createShellTools 里完成，执行时不再起探测进程）。
     * @param decode 输出解码器。
     */
    constructor(
        private readonly cwd: string,
        private readonly shell: ShellSpec,
        private readonly decode: OutputDecoder
    ) {}

    async executeCommand(rawCommand: string): Promise<CommandResult> {
        const startedAt = Date.now();
        const timeoutMs = resolveShellTimeoutMs();
        const shell = this.shell;
        const decode = this.decode;
        const command = adaptCommandForShell(rawCommand, shell.kind);
        const stdout = createAccumulator();
        const stderr = createAccumulator();

        return new Promise<CommandResult>((resolve) => {
            let settled = false;
            let timedOut = false;
            let timer: NodeJS.Timeout | undefined;
            let graceTimer: NodeJS.Timeout | undefined;

            const finish = (exitCode: number): void => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (graceTimer) clearTimeout(graceTimer);
                // 宽限路径下 'close' 可能永不到来，主动断开管道以免留下悬挂的 fd
                child.stdout?.destroy();
                child.stderr?.destroy();

                const stderrText = finalizeStream(stderr, 'stderr', decode);
                const result: CommandResult = {
                    stdout: finalizeStream(stdout, 'stdout', decode),
                    stderr: timedOut
                        ? `${stderrText}${stderrText ? '\n' : ''}[命令执行超过 ${timeoutMs}ms，已被强制结束]`
                        : stderrText,
                    exitCode
                };

                const durationMs = Date.now() - startedAt;
                log.info('命令执行完成', {
                    exitCode: result.exitCode,
                    durationMs,
                    timedOut,
                    cmd: previewCommand(command)
                });
                auditLog({
                    ts: dayjs(startedAt).toISOString(),
                    command,
                    exitCode: result.exitCode,
                    durationMs,
                    timedOut,
                    stdoutBytes: stdout.bytes,
                    stderrBytes: stderr.bytes,
                    stdoutTruncated: stdout.truncated,
                    stderrTruncated: stderr.truncated
                });

                resolve(result);
            };

            let child: ChildProcess;
            try {
                const invocation = buildInvocation(shell, command);
                child = spawn(shell.bin, invocation.args, {
                    cwd: this.cwd,
                    // detached 让子进程成为进程组组长，超时才能整组终止（见 killProcessGroup）
                    detached: process.platform !== 'win32',
                    // Windows 下 Electron 是 GUI 进程，不隐藏会每条命令弹出一个控制台窗口
                    windowsHide: true,
                    windowsVerbatimArguments: invocation.verbatim,
                    // stdin 默认 ignore：若是 pipe 且不关闭，`cat` 这类无参命令会一直等输入直到超时。
                    // PowerShell 经 stdin 传命令，写完立即 end，效果与 ignore 相同。
                    stdio: [invocation.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
                });
                if (invocation.stdin !== undefined) {
                    // shell 快速退出时写 stdin 可能 EPIPE，结果以退出码/stderr 为准，此处忽略
                    child.stdin?.on('error', () => {});
                    child.stdin?.end(invocation.stdin);
                }
            } catch (error) {
                // spawn 同步抛（参数非法等）。异步的 ENOENT 由下面的 'error' 事件处理。
                log.error('无法启动 shell', { err: error });
                auditLog({
                    ts: dayjs(startedAt).toISOString(),
                    command,
                    exitCode: EXIT_SPAWN_FAILED,
                    durationMs: Date.now() - startedAt,
                    spawnError: errorMessage(error)
                });
                resolve({ stdout: '', stderr: `无法启动 shell: ${errorMessage(error)}`, exitCode: EXIT_SPAWN_FAILED });
                return;
            }

            child.stdout?.on('data', (chunk: Buffer) => pushChunk(stdout, chunk));
            child.stderr?.on('data', (chunk: Buffer) => pushChunk(stderr, chunk));

            child.on('error', (error) => {
                // 典型是 ENOENT（shell 不存在）。写入 stderr 让模型能看见原因。
                pushChunk(stderr, Buffer.from(`无法执行命令: ${errorMessage(error)}`, 'utf8'));
                finish(EXIT_SPAWN_FAILED);
            });

            child.on('close', (code, signal) => {
                if (timedOut) {
                    finish(EXIT_TIMEOUT);
                    return;
                }
                finish(code ?? signalExitCode(signal));
            });

            timer = setTimeout(() => {
                timedOut = true;
                killProcessGroup(child);
                // 若组内有进程脱离了进程组（自行 setsid）并占用管道，'close' 不会触发；
                // 增加一道宽限，到时按超时结算，避免一次工具调用永久挂起。
                graceTimer = setTimeout(() => finish(EXIT_TIMEOUT), KILL_GRACE_MS);
            }, timeoutMs);
        });
    }

    async readFile(filePath: string): Promise<string> {
        // 错误文案沿用 bash-tool 的约定（它按 "File not found:" 区分不存在）
        try {
            return await fsp.readFile(filePath, 'utf8');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                throw new Error(`File not found: ${filePath}`, { cause: error });
            }
            throw new Error(`Failed to read file: ${filePath}: ${errorMessage(error)}`, { cause: error });
        }
    }

    async writeFiles(files: Array<{ path: string; content: string | Buffer }>): Promise<void> {
        for (const file of files) {
            await fsp.mkdir(path.dirname(file.path), { recursive: true });
            await fsp.writeFile(file.path, file.content);
        }
    }
}

// ---------------------------------------------------------------------------
// 技能文档 seed（只 seed 启用技能 + 清理停用技能残留）
// ---------------------------------------------------------------------------

/** createShellTools 的可选项。 */
export interface CreateShellToolsOptions {
    /**
     * 可选的项目主工作目录（绝对路径）。传入后 Bash/Read/Write 的 cwd 指向该目录，
     * 且**不再**把技能参考文档拷进去（那是用户真实工作区，拷 .md 会污染），因此项目模式下
     * 没有自动的 "Available files" 清单。不传时沿用进程级临时 workspace + 上传技能文档。
     */
    primaryDir?: string;
    /**
     * 可选的项目附加工作目录（绝对路径数组）。真实 shell 本就能访问任意绝对路径，这里仅用于在
     * 工具说明里告知模型这些目录可用；不改变 cwd（相对路径仍按 primaryDir 解析）。
     */
    additionalDirs?: string[];
    /**
     * userDir 下**启用**技能的物理目录名（basename）。只在默认 workspace 模式生效：
     * uploadDirectory.include 会据此收窄，只 seed 这些技能的 .md——否则停用技能的文档会进入
     * bash 工具描述的 "Available files" 清单，被模型误当成可用技能（见 registry.getUserSkillDirNames）。
     * 同时据此把这些技能的脚本等非文档资源同步进 workspace（见 seedSkillResources）。
     * 传 `undefined` 走历史行为（seed 全部 .md）；传空数组表示「无启用技能」，不 seed 任何文档。
     */
    enabledSkillDirs?: string[];
    /**
     * userDir 下**停用**技能的物理目录名（basename）。用于清理 workspace（持久 tmp 目录）里
     * 历史 session 残留的这些目录，避免模型 `ls` 仍能看到已停用技能。
     */
    disabledSkillDirs?: string[];
    /**
     * 文件检查点记录器（已绑定 sessionId + 当前用户轮 turnId）。传入后 Write/Edit 在首次改动
     * 某文件前快照其 pre 状态，供 `POST /api/conversations/:id/rewind` 回滚。不传则不记检查点。
     */
    checkpoint?: CheckpointRecorder;
    /** 追加给 Grep（rg）的排除 glob，由装配点按权限策略的 Read-deny 规则给出。 */
    grepExcludeGlobs?: string[];
}

/**
 * 受保护写入路径判定：即使在自动放行/危险模式下，也拒绝写入升权敏感位置——
 * 任何 `.git` / `.ssh` 目录内部（含 git hooks/config）、用户 `~/.ssh`、应用自身数据目录 `~/.zhuixun`。
 * 防「拿到可写权限 → 改 git hook / 写 SSH / 篡改应用配置」的越权。
 */
export function isProtectedWrite(target: string): boolean {
    const resolved = path.resolve(target);
    const segs = resolved.split(path.sep);
    if (segs.includes('.git') || segs.includes('.ssh')) return true;
    const home = os.homedir();
    const deny = [path.join(home, '.zhuixun'), path.join(home, '.ssh')];
    return deny.some((d) => resolved === d || resolved.startsWith(d + path.sep));
}

/** 目录名是否安全用于拼接进 workspace 路径（防越权删除到 workspace 之外）。 */
function isSafeDirName(name: string): boolean {
    return !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

/**
 * 构造只 seed「启用技能」的 uploadDirectory。返回 undefined 表示本轮不 seed 任何文档。
 *
 * fast-glob（bash-tool 底层）的单元素花括号 `{a}` 不展开（bash 语义），单目录必须用裸模式，
 * 多目录才用 `{a,b}`；目录名遵循 kebab-case 技能约定，不含花括号/逗号等 glob 元字符。
 */
function buildSkillUploadDirectory(
    skillsDir: string,
    enabledSkillDirs: string[] | undefined
): { source: string; include: string } | undefined {
    // 未传：保持历史行为（seed 全部 .md）。runner 默认工作区模式一定会传，此处仅作兜底。
    if (enabledSkillDirs === undefined) {
        return { source: skillsDir, include: '**/*.md' };
    }
    const safe = enabledSkillDirs.filter(isSafeDirName);
    if (safe.length === 0) return undefined;
    const dirGlob = safe.length === 1 ? safe[0] : `{${safe.join(',')}}`;
    return { source: skillsDir, include: `${dirGlob}/**/*.md` };
}

/**
 * 把启用技能的非 .md 资源（scripts/ 等）同步进 workspace 的同名技能目录。
 *
 * 为什么需要：bash-tool 的 uploadDirectory 只 seed `.md`（供 Available files 清单），workspace 里于是
 * 出现与真实技能同名、却缺脚本的「半份」目录；模型按 SKILL.md 的相对路径在 cwd 下找 `scripts/*.py`
 * 找不到，就误判技能不带脚本（会话 0cef64d1 实例）。直接指向 `~/.zhuixun/skills` 也不行：
 * Bash 命令含 `.zhuixun` 一律 ask。故补齐资源，让 workspace 副本与 load_skill 返回的 directory 一致。
 *
 * - `.md` 仍由 bash-tool 写入，这里跳过以免并发重复写；符号链接跳过（与 listResourceFiles 只列普通文件一致）。
 * - 保留时间戳，大小与 mtime 未变的文件不重写：workspace 跨会话共享，避免覆盖正被其它会话执行的脚本。
 * - 单个技能同步失败只告警；load_skill 会校验副本完整性，不完整时退回真实目录。
 */
async function seedSkillResources(skillsDir: string, workspace: string, enabledSkillDirs: string[] | undefined) {
    // 未传 enabledSkillDirs 走历史行为（只 seed 文档），与 buildSkillUploadDirectory 的兜底一致
    if (!enabledSkillDirs) return;
    await Promise.all(
        enabledSkillDirs.filter(isSafeDirName).map(async (name) => {
            const source = path.join(skillsDir, name);
            try {
                await fsp.cp(source, path.join(workspace, name), {
                    recursive: true,
                    force: true,
                    preserveTimestamps: true,
                    filter: async (src, dest) => {
                        const rel = path.relative(source, src).split(path.sep).join('/');
                        if (!rel) return true;
                        if (!isSeedableSkillResource(rel)) return false;
                        const stat = await fsp.lstat(src);
                        if (stat.isSymbolicLink()) return false;
                        if (stat.isDirectory()) return true;
                        if (rel.endsWith('.md')) return false;
                        const existing = await fsp.stat(dest).catch(() => undefined);
                        // 用 <1ms 容差而非 Math.trunc 精确相等：fsp.cp 的 preserveTimestamps 经 utimes
                        // 只能存到整毫秒，源 mtime 在 APFS 上有亚毫秒小数会被四舍五入（如 .5208 → 进 1ms），
                        // 直接比较整数部分会在一半情况下误判"已变更"而重写脚本（见 agent-shell-files 偶发失败）。
                        const sameMtime = existing && Math.abs(existing.mtimeMs - stat.mtimeMs) < 1;
                        return !(existing && existing.size === stat.size && sameMtime);
                    }
                });
            } catch (error) {
                log.warn('同步技能资源到工作区失败', { dir: name, err: error });
            }
        })
    );
}

/**
 * 删除 workspace 里遗留的停用技能目录。
 *
 * workspace 是固定的持久 tmp 目录（{@link WORKSPACE_DIR}），历史 session seed 进去的技能目录
 * 不会自动消失；某技能被前端停用后，只收窄 uploadDirectory 不会删除它已在盘上的旧副本，模型
 * `ls` 仍能发现它。此处按「停用技能目录名」精确删除，仅处理技能副本，不影响模型自身产出的文件。
 */
async function removeStaleSkillDirs(workspace: string, disabledSkillDirs: string[] | undefined): Promise<void> {
    if (!disabledSkillDirs || disabledSkillDirs.length === 0) return;
    await Promise.all(
        disabledSkillDirs.filter(isSafeDirName).map(async (name) => {
            try {
                await fsp.rm(path.join(workspace, name), { recursive: true, force: true });
            } catch (error) {
                // 清理失败不影响 shell 工具本身，仅告警
                log.warn('清理停用技能残留目录失败', { dir: name, err: error });
            }
        })
    );
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 创建本地 shell 工具集：`Bash` / `Read` / `Write`。
 *
 * @param skillsDir 技能根目录（可写用户目录）。**必须由调用方传入，不能在这里用 `import.meta.url`
 *   推导**：本模块在 dev 下位于 `src/core/tools/`，被 esbuild 内联进 `server.js` 后 `import.meta.url`
 *   变成 `resources/backend/server.js`，同一行相对路径在两种形态下会指向不同地方。调用方传的是
 *   `app.ts` 里已正确计算的 skillsDir。
 * @param options 见 {@link CreateShellToolsOptions}。默认工作区模式下，只 seed `enabledSkillDirs`
 *   指定的启用技能文档，并清理 `disabledSkillDirs` 的残留目录。
 *
 * Windows：shell 按 pwsh 7 → Windows PowerShell 5.x → cmd 探测（见 windows-shell.ts），执行层剥掉
 *   bash-tool 的 `cd "..." &&` 前缀、按系统代码页解码输出，工具说明按实际方言提供语法提示。
 *   调用方仍应捕获异常并降级为「本轮无 shell 工具」。
 */
export async function createShellTools(skillsDir: string, options: CreateShellToolsOptions = {}): Promise<ToolSet> {
    const { primaryDir, additionalDirs, enabledSkillDirs, disabledSkillDirs, checkpoint, grepExcludeGlobs } = options;

    // 项目主工作目录必须已存在（调用方在发起会话时已探活），此处不自动创建用户目录；
    // 仅在使用默认临时 workspace 时才 mkdir。
    const cwd = primaryDir || WORKSPACE_DIR;
    const [shell, decode] = await Promise.all([
        resolveShell(),
        process.platform === 'win32' ? createWindowsDecoder() : Promise.resolve(decodeUtf8),
        primaryDir
            ? undefined
            : fsp
                  .mkdir(WORKSPACE_DIR, { recursive: true })
                  // 先清理历史 session 残留的停用技能目录，再补齐启用技能的脚本等资源；
                  // 文档（.md）随后由 uploadDirectory seed。
                  .then(() => removeStaleSkillDirs(WORKSPACE_DIR, disabledSkillDirs))
                  .then(() => seedSkillResources(skillsDir, WORKSPACE_DIR, enabledSkillDirs))
    ]);

    // 只有默认 workspace 才 seed 技能文档（并据此生成 Available files 清单）；
    // 项目工作目录是用户真实文件夹，不做上传，避免污染。
    const uploadDirectory = primaryDir ? undefined : buildSkillUploadDirectory(skillsDir, enabledSkillDirs);

    const sandbox = new LocalShellSandbox(cwd, shell, decode);
    const { tools } = await createBashTool({
        sandbox,
        destination: cwd,
        ...(uploadDirectory ? { uploadDirectory } : {}),
        maxOutputLength: MAX_OUTPUT_LENGTH,
        promptOptions: {
            toolPrompt: buildShellToolPrompt(resolveShellTimeoutMs(), shell, {
                projectDir: !!primaryDir,
                hasSkillDocs: !!uploadDirectory,
                additionalDirs
            })
        }
    });

    // bash-tool 的 Read/Write 用 path.posix.resolve 拼接路径：Windows 下 `C:\...` 不被视为绝对路径，
    // 会被拼接到进程 cwd 之后成为不存在的路径。改用平台原生 path.resolve（posix 上两者等价）。
    const read: typeof tools.readFile = {
        ...tools.readFile,
        execute: async ({ path: filePath }) => ({ content: await sandbox.readFile(path.resolve(cwd, filePath)) })
    };
    const write: typeof tools.writeFile = {
        ...tools.writeFile,
        execute: async ({ path: filePath, content }) => {
            const target = path.resolve(cwd, filePath);
            // 升权敏感路径护栏：即便在自动放行/危险模式下也拒绝（.git/.ssh/应用数据目录等）。
            if (isProtectedWrite(target)) {
                throw new Error(`拒绝写入受保护路径：${target}（.git / .ssh / 应用数据目录等升权敏感位置不可写）`);
            }
            await checkpoint?.record(target);
            await sandbox.writeFiles([{ path: target, content }]);
            return { success: true };
        }
    };

    // tools.bash 是本次调用新建的对象，直接改写描述即可（bash-tool 生成的一定是字符串）
    if (typeof tools.bash.description === 'string') {
        tools.bash.description = adaptBashDescription(tools.bash.description, shell.kind);
    }

    // 结构化编辑 / 检索工具（Edit/Grep/Glob/LS）与 Bash/Read/Write 共用同一工作目录语义。
    return {
        Bash: tools.bash,
        Read: read,
        Write: write,
        ...createEditSearchTools(cwd, checkpoint, grepExcludeGlobs)
    };
}

/** 供测试/排查使用：当前 workspace 与审计文件位置。 */
export const shellPaths = {
    workspace: WORKSPACE_DIR,
    auditFile: paths.auditFile()
};
