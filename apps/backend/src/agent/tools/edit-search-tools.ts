import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { MAX_OUTPUT_LENGTH } from '@/config/shell';
import type { CheckpointRecorder } from '@/modules/conversations';
import { createLogger } from '@/platform/logging/index';

import { isProtectedWrite } from './shell-tools';

const log = createLogger('EditSearch');

/** Glob 单次返回文件数上限，防超大仓把结果撑爆上下文。 */
const MAX_GLOB_RESULTS = 1000;
/** Grep 子进程硬超时（ms）。检索应很快，超时按异常处理。 */
const GREP_TIMEOUT_MS = 30_000;

/**
 * 解析 ripgrep 可执行文件路径（惰性、绝不在模块加载期触发，避免崩后端启动）：
 * 1) 打包形态（tsup 单文件 + Electron resources，无 node_modules）：electron-builder extraResources
 *    入包 rg 后用 `ZHUIXUN_RG_PATH` 指定；
 * 2) dev / 内嵌 bundle（tsup 对 @vscode/ripgrep 保持 external，见 tsup.config.ts）：运行时 require 其 rgPath；
 * 3) 兜底：系统 PATH 上的 `rg`。
 * @vscode/ripgrep 的 index.js 会按平台 require 其二进制包，一旦被内联会在加载期抛错；此处 try/catch 兜底，
 * 任何解析失败都降级为系统 rg，绝不让 Grep 崩掉后端启动。
 */
let cachedRgPath: string | null = null;
function resolveRgPath(): string {
    if (cachedRgPath) return cachedRgPath;
    // 打包形态优先：由 Electron 主进程指向随包 rg（见 electron/main.ts + scripts/after-pack.cjs）；
    // 路径不存在（跨平台出包缺该架构二进制等）则忽略、继续往下兜底，不让 Grep 指向死路径。
    const envPath = process.env.ZHUIXUN_RG_PATH;
    if (envPath && existsSync(envPath)) return (cachedRgPath = envPath);
    try {
        const req = createRequire(import.meta.url);
        const mod = req('@vscode/ripgrep') as { rgPath?: string };
        if (mod?.rgPath) return (cachedRgPath = mod.rgPath);
    } catch (error) {
        log.warn('@vscode/ripgrep 解析失败，回退系统 PATH 上的 rg', { err: error });
    }
    return (cachedRgPath = 'rg');
}

/** ripgrep 运行结果：stdout（可能被截断）、退出码、是否截断。 */
interface RgResult {
    stdout: string;
    exitCode: number | null;
    truncated: boolean;
}

/**
 * 以 rg 子进程执行一次检索，按 MAX_OUTPUT_LENGTH 收口 stdout、GREP_TIMEOUT_MS 硬超时。
 * rg 约定：exitCode 0=有匹配、1=无匹配（非错误）、2=检索出错。
 */
function runRg(args: string[], cwd: string): Promise<RgResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveRgPath(), args, { cwd });
        let stdout = '';
        let stderr = '';
        let truncated = false;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Grep 超时（> ${GREP_TIMEOUT_MS}ms）`));
        }, GREP_TIMEOUT_MS);

        child.stdout.on('data', (chunk: Buffer) => {
            if (truncated) return;
            stdout += chunk.toString('utf8');
            if (stdout.length > MAX_OUTPUT_LENGTH) {
                stdout = `${stdout.slice(0, MAX_OUTPUT_LENGTH)}\n...（输出已截断）`;
                truncated = true;
                child.kill('SIGKILL');
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 2 && !truncated) {
                reject(new Error(`ripgrep 检索出错：${stderr.trim() || '未知错误'}`));
                return;
            }
            resolve({ stdout, exitCode: code, truncated });
        });
    });
}

/**
 * 结构化编辑 / 检索工具集：`Edit`（精确字符串替换）/ `Grep`（ripgrep 内容检索）/
 * `Glob`（文件名匹配）/ `LS`（列目录）。与 Bash/Read/Write 同在 createShellTools 的工作目录语义下：
 * 相对路径相对于 `cwd` 解析；Edit 写入前过 `isProtectedWrite` 护栏。Grep/Glob/LS 只读、无需审批，
 * Edit 的审批由 agent 的 toolApproval（按 `file_path`，复用 Write 网关）把关。
 *
 * @param cwd 会话工作目录（项目主目录或临时 workspace）
 * @param checkpoint 可选文件检查点记录器；传入后 Edit 在改动前快照 pre 状态供回滚
 * @param grepExcludeGlobs 追加给 rg 的排除 glob（如权限策略 Read-deny 规则转出的排除项），防目录检索绕过单文件 deny
 */
export function createEditSearchTools(
    cwd: string,
    checkpoint?: CheckpointRecorder,
    grepExcludeGlobs: string[] = []
): ToolSet {
    return {
        Edit: tool({
            description: [
                '对单个已有文件做精确字符串替换，优先于用 Write 整文件覆写（避免丢改动）。',
                'old_string 需与文件内容逐字符一致（含缩进/空白），且默认必须唯一命中；',
                '不唯一时请补足上下文使其唯一，或设 replace_all:true 全量替换。'
            ].join(''),
            inputSchema: z.object({
                file_path: z.string().describe('要编辑的文件路径（相对则相对于工作目录）'),
                old_string: z.string().describe('被替换的原文（逐字符一致，含缩进与空白）'),
                new_string: z.string().describe('替换后的新内容'),
                replace_all: z.boolean().optional().describe('是否替换所有匹配，默认 false（要求唯一命中）')
            }),
            execute: async ({ file_path, old_string, new_string, replace_all }) => {
                const target = path.resolve(cwd, file_path);
                if (isProtectedWrite(target)) {
                    throw new Error(`拒绝写入受保护路径：${target}（.git / .ssh / 应用数据目录等升权敏感位置不可写）`);
                }
                if (old_string === '') throw new Error('old_string 不能为空');
                if (old_string === new_string) throw new Error('old_string 与 new_string 相同，无需编辑');
                let content: string;
                try {
                    content = await fsp.readFile(target, 'utf8');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        throw new Error(`File not found: ${target}`, { cause: error });
                    }
                    throw error;
                }
                const occurrences = content.split(old_string).length - 1;
                if (occurrences === 0) throw new Error('old_string 未在文件中找到（含缩进/空白需逐字符一致）');
                if (occurrences > 1 && !replace_all) {
                    throw new Error(`old_string 命中 ${occurrences} 处，不唯一；请补充上下文或设 replace_all:true`);
                }
                let next: string;
                if (replace_all) {
                    next = content.split(old_string).join(new_string);
                } else {
                    const idx = content.indexOf(old_string);
                    next = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
                }
                await checkpoint?.record(target);
                await fsp.writeFile(target, next, 'utf8');
                log.info('Edit 文件', { path: target, replacements: replace_all ? occurrences : 1 });
                return { success: true, path: target, replacements: replace_all ? occurrences : 1 };
            }
        }),

        Grep: tool({
            description: [
                '用 ripgrep 在文件内容中按正则检索（代码搜索），优先于用 Bash 调 grep/sed。只读、无需审批。',
                'outputMode：content（默认，带文件:行号:内容）/ files（仅文件名）/ count（每文件匹配数）。'
            ].join(''),
            inputSchema: z.object({
                pattern: z.string().describe('ripgrep 正则表达式'),
                path: z.string().optional().describe('搜索路径（相对则相对于工作目录），默认工作目录'),
                glob: z.string().optional().describe('仅在匹配该 glob 的文件中搜，如 "*.ts"、"!*.test.ts"'),
                ignoreCase: z.boolean().optional().describe('忽略大小写'),
                outputMode: z.enum(['content', 'files', 'count']).optional().describe('输出模式，默认 content'),
                contextLines: z.number().int().min(0).max(20).optional().describe('content 模式下每个匹配前后显示行数'),
                maxMatches: z
                    .number()
                    .int()
                    .positive()
                    .max(1000)
                    .optional()
                    .describe('content 模式下每文件最多匹配数，默认 200')
            }),
            execute: async ({ pattern, path: searchPath, glob, ignoreCase, outputMode, contextLines, maxMatches }) => {
                const mode = outputMode ?? 'content';
                const args = ['--color', 'never'];
                if (ignoreCase) args.push('-i');
                if (glob) args.push('--glob', glob);
                // 排除 glob 放在用户 glob 之后：rg 后出现的 glob 优先，模型无法用 glob 参数重新纳入被拒文件
                for (const exclude of grepExcludeGlobs) args.push('--glob', exclude);
                if (mode === 'files') args.push('-l');
                else if (mode === 'count') args.push('-c');
                else {
                    args.push('--no-heading', '-n', '-m', String(maxMatches ?? 200));
                    if (contextLines) args.push('-C', String(contextLines));
                }
                args.push('-e', pattern, path.resolve(cwd, searchPath ?? '.'));
                const { stdout, exitCode, truncated } = await runRg(args, cwd);
                return {
                    matched: exitCode === 0,
                    output: exitCode === 1 && !stdout ? '（无匹配）' : stdout,
                    truncated
                };
            }
        }),

        Glob: tool({
            description: '按 glob 模式匹配文件，返回路径列表（按最近修改时间倒序）。只读、无需审批。',
            inputSchema: z.object({
                pattern: z.string().describe('glob 模式，如 "**/*.ts"、"src/**/*.tsx"'),
                path: z.string().optional().describe('搜索根目录（相对则相对于工作目录），默认工作目录')
            }),
            execute: async ({ pattern, path: base }) => {
                const root = path.resolve(cwd, base ?? '.');
                const matches: string[] = [];
                let truncated = false;
                for await (const m of fsp.glob(pattern, { cwd: root })) {
                    matches.push(path.resolve(root, m));
                    if (matches.length >= MAX_GLOB_RESULTS) {
                        truncated = true;
                        break;
                    }
                }
                const withMtime = await Promise.all(
                    matches.map(async (f) => {
                        try {
                            return { f, mtime: (await fsp.stat(f)).mtimeMs };
                        } catch {
                            return { f, mtime: 0 };
                        }
                    })
                );
                withMtime.sort((a, b) => b.mtime - a.mtime);
                return { count: withMtime.length, truncated, files: withMtime.map((x) => x.f) };
            }
        }),

        LS: tool({
            description: '列出目录内容（名称 + 类型：dir/file/symlink），目录优先、同类按名排序。只读、无需审批。',
            inputSchema: z.object({
                path: z.string().describe('要列出的目录路径（相对则相对于工作目录）'),
                ignoreHidden: z.boolean().optional().describe('忽略以 . 开头的隐藏项，默认 false')
            }),
            execute: async ({ path: p, ignoreHidden }) => {
                const target = path.resolve(cwd, p);
                let entries;
                try {
                    entries = await fsp.readdir(target, { withFileTypes: true });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        throw new Error(`目录不存在：${target}`, { cause: error });
                    }
                    throw error;
                }
                const items = entries
                    .filter((e) => !ignoreHidden || !e.name.startsWith('.'))
                    .map((e) => ({
                        name: e.name,
                        type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file'
                    }))
                    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
                return { path: target, entries: items };
            }
        })
    };
}
