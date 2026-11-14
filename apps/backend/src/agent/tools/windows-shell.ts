import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import iconv from 'iconv-lite';

import { inferShellKind, shellOverride, type ShellSpec } from '@/config/shell';
import { createLogger } from '@/platform/logging/index';

/**
 * Windows 下 Bash 工具的执行适配层：选 shell、拼接参数、解码输出。
 *
 * 要解决的问题（Windows 实测日志）
 * ------------------------------
 * 1. bash-tool 把每条命令拼成 `cd "<cwd>" && <cmd>`，Windows PowerShell 5.x 不支持 `&&`，
 *    **所有命令**在解析阶段就失败；
 * 2. PowerShell / systeminfo 等写管道时用系统 OEM 代码页（中文 936、日文 932、西欧 437/850…），
 *    按 UTF-8 解码会产生乱码，模型无法识别报错内容会误判原因；
 * 3. 命令经 Windows 命令行传参，双引号/反斜杠要过 Node 与 PowerShell 两层转义，容易被丢弃。
 *
 * 方案
 * ----
 * - shell 选择：`ZHUIXUN_SHELL` → pwsh（7.x，支持 `&&`）→ Windows PowerShell（5.x）→ cmd。
 *   每个候选都实际执行一次探测（版本号 + 语言模式），无法启动或处于 ConstrainedLanguage
 *   （WDAC/AppLocker 锁定，引导脚本无法使用 .NET 方法）则顺延到下一个；结果进程级缓存。
 * - PowerShell 传参：命令**不经由命令行**，以 base64(UTF-8) 写入 stdin，由固定的引导脚本解码后
 *   `Invoke-Expression`。base64 是纯 ASCII，与任何代码页/InputEncoding 无关，也没有长度与转义问题；
 *   引导脚本先将输出编码切换为 UTF-8 再执行用户命令，所以连用户命令的**语法错误**也是 UTF-8 输出。
 * - 输出解码：先严格 UTF-8；不合法（个别原生程序无视控制台代码页）再按探测到的系统 OEM 代码页
 *   用 iconv-lite 解码——不硬编码任何语言区。
 */

const log = createLogger('WindowsShell');

/** 探测命令的超时：冷启动的 PowerShell 在杀毒软件扫描下可能需要数秒。 */
const PROBE_TIMEOUT_MS = 15_000;

function systemRoot(): string {
    return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}

function findOnPath(exe: string): string | undefined {
    for (const dir of (process.env.PATH ?? '').split(path.win32.delimiter)) {
        if (!dir) continue;
        const candidate = path.win32.join(dir.replace(/^"|"$/g, ''), exe);
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

/** 执行一个探测命令，成功（退出码 0）返回 stdout 文本，否则 undefined。探测输出都是 ASCII。 */
function runProbe(bin: string, args: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile(bin, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'buffer' }, (error, stdout) =>
            resolve(error ? undefined : stdout.toString('latin1'))
        );
    });
}

interface PowerShellProbe {
    major: number | undefined;
    fullLanguage: boolean;
}

async function probePowerShell(bin: string): Promise<PowerShellProbe | undefined> {
    const out = await runProbe(bin, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$PSVersionTable.PSVersion.Major; $ExecutionContext.SessionState.LanguageMode'
    ]);
    if (out === undefined) return undefined;
    const [majorLine = '', modeLine = ''] = out.trim().split(/\r?\n/);
    const major = Number.parseInt(majorLine.trim(), 10);
    return { major: Number.isFinite(major) ? major : undefined, fullLanguage: modeLine.trim() === 'FullLanguage' };
}

/** pwsh 优先（7.x 支持 `&&`/`||`、默认 UTF-8），再 Windows PowerShell；去重且只留存在的路径。 */
function powerShellCandidates(): string[] {
    const programFiles = [process.env.ProgramW6432, process.env.ProgramFiles].filter((p): p is string => !!p);
    const pwsh = [
        findOnPath('pwsh.exe'),
        ...programFiles.flatMap((pf) =>
            ['7', '7-preview', '6'].map((v) => path.win32.join(pf, 'PowerShell', v, 'pwsh.exe'))
        )
    ];
    const windowsPowerShell = [
        path.win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        findOnPath('powershell.exe')
    ];
    const seen = new Set<string>();
    return [...pwsh, ...windowsPowerShell].filter((p): p is string => {
        if (!p || seen.has(p.toLowerCase()) || !fs.existsSync(p)) return false;
        seen.add(p.toLowerCase());
        return true;
    });
}

function cmdPath(): string {
    return process.env.ComSpec || path.win32.join(systemRoot(), 'System32', 'cmd.exe');
}

async function detectWindowsShell(override: string | undefined): Promise<ShellSpec> {
    if (override) {
        const kind = inferShellKind(override);
        if (kind !== 'powershell') return { bin: override, kind };
        const probe = await probePowerShell(override);
        if (!probe) log.warn('ZHUIXUN_SHELL 指定的 PowerShell 探测失败，仍按其执行', { bin: override });
        return { bin: override, kind, psMajor: probe?.major };
    }

    for (const bin of powerShellCandidates()) {
        const probe = await probePowerShell(bin);
        if (!probe) {
            log.warn('PowerShell 候选无法启动，尝试下一个', { bin });
            continue;
        }
        if (!probe.fullLanguage) {
            // 语言模式是系统级策略（WDAC/AppLocker），更换其他 PowerShell 结果相同，直接回落到 cmd
            log.warn('PowerShell 处于受限语言模式，改用 cmd', { bin });
            break;
        }
        log.info('选定 Windows shell', { bin, psMajor: probe.major });
        return { bin, kind: 'powershell', psMajor: probe.major };
    }

    const cmd = cmdPath();
    log.warn('无可用 PowerShell，回落 cmd', { bin: cmd });
    return { bin: cmd, kind: 'cmd' };
}

let shellCache: { override: string | undefined; spec: Promise<ShellSpec> } | undefined;

/** 解析 Windows 下的 shell（进程级缓存；`ZHUIXUN_SHELL` 变化时重新探测）。 */
export function resolveWindowsShell(): Promise<ShellSpec> {
    const override = shellOverride();
    if (!shellCache || shellCache.override !== override) {
        shellCache = { override, spec: detectWindowsShell(override) };
    }
    return shellCache.spec;
}

// ---------------------------------------------------------------------------
// 输出解码
// ---------------------------------------------------------------------------

/**
 * 系统 OEM 代码页（控制台程序写管道的默认编码）。先读注册表（reg.exe 输出为 ASCII，不受语言区影响），
 * 失败再解析 `chcp` 的输出末尾数字（其文案本地化，但代码页数字不会）。
 */
async function detectOemCodePage(): Promise<number | undefined> {
    const reg = await runProbe(path.win32.join(systemRoot(), 'System32', 'reg.exe'), [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage',
        '/v',
        'OEMCP'
    ]);
    const fromReg = reg && /OEMCP\s+REG_SZ\s+(\d+)/i.exec(reg)?.[1];
    if (fromReg) return Number(fromReg);
    const chcp = await runProbe(cmdPath(), ['/d', '/c', 'chcp']);
    const fromChcp = chcp && /(\d+)\D*$/.exec(chcp.trim())?.[1];
    return fromChcp ? Number(fromChcp) : undefined;
}

let codePageCache: Promise<number | undefined> | undefined;

/**
 * 生成 Windows 输出解码器：严格 UTF-8 优先（引导脚本已把 PowerShell/控制台切到 UTF-8，node 等也输出
 * UTF-8），不合法时按系统 OEM 代码页解码；代码页探测失败或 iconv 不支持时退回宽松 UTF-8。
 *
 * **按行**判定而不是整段：一条命令里常混着 UTF-8 输出（PowerShell 自身、node）与 OEM 输出（个别无视
 * 控制台代码页的旧程序），整段回落会导致 UTF-8 部分也被错误解码。按 `\n`（0x0A）切分是安全的——UTF-8 与所有
 * Windows OEM 代码页（含 936/932/949/950 双字节）的多字节序列里都不会出现 0x0A。
 */
export async function createWindowsDecoder(): Promise<(buf: Buffer) => string> {
    codePageCache ??= detectOemCodePage();
    return buildDecoder(await codePageCache);
}

/** 按给定 OEM 代码页构造解码器（与探测解耦，便于单独验证各语言区）。 */
export function buildDecoder(codePage: number | undefined): (buf: Buffer) => string {
    const legacy =
        codePage && codePage !== 65001 && iconv.encodingExists(`cp${codePage}`) ? `cp${codePage}` : undefined;
    if (!legacy && codePage !== 65001) {
        log.warn('未能确定系统 OEM 代码页，非 UTF-8 输出将按 UTF-8 宽松解码', { codePage });
    }
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const decodeLine = (line: Buffer): string => {
        try {
            return utf8.decode(line);
        } catch {
            return legacy ? iconv.decode(line, legacy) : line.toString('utf8');
        }
    };
    const decode = (buf: Buffer): string => {
        // 快路径：整段合法 UTF-8（绝大多数情况）
        try {
            return utf8.decode(buf);
        } catch {
            /* 含非 UTF-8 行，逐行解 */
        }
        const parts: string[] = [];
        let start = 0;
        for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, start)) {
            parts.push(decodeLine(buf.subarray(start, i + 1)));
            start = i + 1;
        }
        if (start < buf.length) parts.push(decodeLine(buf.subarray(start)));
        return parts.join('');
    };
    // pwsh 7.x 的错误视图即使重定向、设了 PlainText 仍带 ANSI 颜色码，各类原生 CLI 也可能着色；
    // 模型只需要文本，统一剥离控制序列，并把 CRLF 归一成 LF
    return (buf) => stripVTControlCharacters(decode(buf)).replace(/\r\n/g, '\n');
}

/** 启动时预热：把 shell 探测与代码页探测提前到后台，避免首轮对话为此额外等待数秒。 */
export function prewarmWindowsShell(): void {
    if (process.platform !== 'win32') return;
    void resolveWindowsShell();
    void createWindowsDecoder();
}

// ---------------------------------------------------------------------------
// 调用参数
// ---------------------------------------------------------------------------

/**
 * PowerShell 引导脚本（5.x 与 7.x 通用语法）。整段**不含双引号**，Node 传参时只会在外层包一对引号，
 * 不存在转义问题。步骤：关闭进度条 → 输出编码切换为 UTF-8 → 关闭 ANSI 着色 → 从 stdin 读 base64 解出用户命令 →
 * `Invoke-Expression` 执行（语法错误在此处才被抛出，因此也以 UTF-8 输出）→ 映射退出码：
 * 用户 `exit N` 直接生效；原生命令非 0 退出时透传其 `$LASTEXITCODE`；PowerShell 命令报错
 * （终止性异常，或 `Get-Item 不存在的路径` 这类非终止错误——它们不会让 `$?` 变 false，依靠 `$Error` 计数）为 1；否则 0。
 */
const POWERSHELL_BOOTSTRAP = [
    "$ProgressPreference = 'SilentlyContinue'",
    'try { $__dwUtf8 = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $__dwUtf8; $OutputEncoding = $__dwUtf8 } catch {}',
    "try { if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' } } catch {}",
    "$__dwSrc = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String((@($input) -join '')))",
    '$global:LASTEXITCODE = 0',
    '$Error.Clear()',
    '$__dwOk = $true',
    'try { Invoke-Expression $__dwSrc; $__dwOk = $? } catch { $__dwOk = $false; [Console]::Error.WriteLine(($_ | Out-String).TrimEnd()) }',
    'if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE }',
    'if ($__dwOk -and $Error.Count -eq 0) { exit 0 }',
    'exit 1'
].join('; ');

export interface ShellInvocation {
    args: string[];
    /** 需要写入 stdin 的内容；undefined 表示 stdin 直接 ignore。 */
    stdin?: string;
    /** 对应 spawn 的 windowsVerbatimArguments（cmd 的 `/s /c "..."` 需要原样传参）。 */
    verbatim?: boolean;
}

export function buildWindowsInvocation(spec: ShellSpec, command: string): ShellInvocation {
    if (spec.kind === 'powershell') {
        return {
            // -ExecutionPolicy Bypass 只作用于本进程，使模型能执行工作区内的 .ps1；被组策略锁定时 PowerShell 自行忽略
            args: [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-InputFormat',
                'Text',
                '-OutputFormat',
                'Text',
                '-Command',
                POWERSHELL_BOOTSTRAP
            ],
            // 写完即关闭 stdin，命令里的原生程序读 stdin 会立即收到 EOF（与 posix 下 stdin=ignore 等价）
            stdin: Buffer.from(command, 'utf8').toString('base64')
        };
    }
    if (spec.kind === 'cmd') {
        // 与 Node 自身 shell:true 的拼接方式一致：/d 不执行 AutoRun，/s /c "..." 去掉最外层引号后原样执行
        return { args: ['/d', '/s', '/c', `"chcp 65001 >nul & ${command}"`], verbatim: true };
    }
    // ZHUIXUN_SHELL 指向 Git Bash 等 POSIX shell
    return { args: ['-c', command] };
}
