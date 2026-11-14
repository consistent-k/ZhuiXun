import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { HookAuditEntry, HookEventName } from '@zhuixun/shared';
import dayjs from 'dayjs';

import type { HookPostResult, HookToolCall, HookVerdict, ToolHookRunner } from '@/agent/tools/hook-wrapper';
import { buildInvocation, killProcessGroup, resolveShell } from '@/agent/tools/shell-tools';
import { paths } from '@/config/paths';
import { KILL_GRACE_MS, WORKSPACE_DIR } from '@/config/shell';
import { createLogger } from '@/platform/logging/index';

import { activeHooksConfig, type HookCommand, type HookEntry } from './config';

const log = createLogger('Hooks');

/** stdout / stderr 各自的保留上限，超出部分丢弃。 */
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
/** 传给 hook 的工具产出截断长度。 */
const MAX_TOOL_OUTPUT_CHARS = 20 * 1024;
/** Stop 事件传入的最后一条回复截断长度。 */
const MAX_LAST_TEXT_CHARS = 2000;
/** 审计里命令原文截断长度。 */
const AUDIT_COMMAND_MAX = 200;
/** stdin 被 shell 自身占用（PowerShell 经 stdin 传命令）时，载荷改走环境变量的长度上限（Windows 单变量约 32K）。 */
const MAX_ENV_PAYLOAD_CHARS = 16 * 1024;

/** 单个 hook 命令的执行结果。 */
export interface HookExecution {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
    spawnError?: string;
}

export interface HookRunContext {
    sessionId?: string;
    projectId?: string;
    /** 会话主工作目录；缺省走临时工作区 */
    cwd?: string;
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

function stringifyOutput(output: unknown): string {
    if (typeof output === 'string') return truncate(output, MAX_TOOL_OUTPUT_CHARS);
    try {
        return truncate(JSON.stringify(output) ?? '', MAX_TOOL_OUTPUT_CHARS);
    } catch {
        return '';
    }
}

function collect(stream: NodeJS.ReadableStream | null | undefined, sink: { text: string; bytes: number }): void {
    stream?.on('data', (chunk: Buffer) => {
        if (sink.bytes >= MAX_HOOK_OUTPUT_BYTES) return;
        const room = MAX_HOOK_OUTPUT_BYTES - sink.bytes;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        sink.bytes += piece.length;
        sink.text += piece.toString('utf8');
    });
}

/**
 * 以本机 shell 执行一条 hook 命令：独立进程组、超时整组 kill、stdout/stderr 各截断 64KB。
 * 载荷 JSON 写入 stdin；若 stdin 已被 shell 占用（Windows PowerShell 经 stdin 传命令），改放 `ZHUIXUN_HOOK_INPUT`。
 */
export async function executeHookCommand(
    hook: HookCommand,
    payload: Record<string, unknown>,
    env: Record<string, string>,
    cwd: string
): Promise<HookExecution> {
    const startedAt = Date.now();
    const body = JSON.stringify(payload);
    let shellSpec;
    try {
        shellSpec = await resolveShell();
    } catch (error) {
        return { exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs: 0, spawnError: String(error) };
    }
    const invocation = buildInvocation(shellSpec, hook.command);
    const stdinPayload = invocation.stdin === undefined;
    return new Promise<HookExecution>((resolve) => {
        const stdout = { text: '', bytes: 0 };
        const stderr = { text: '', bytes: 0 };
        let settled = false;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        let grace: NodeJS.Timeout | undefined;
        let child: ChildProcess;

        const finish = (exitCode: number | null, spawnError?: string) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (grace) clearTimeout(grace);
            child?.stdout?.destroy();
            child?.stderr?.destroy();
            resolve({
                exitCode,
                stdout: stdout.text,
                stderr: stderr.text,
                timedOut,
                durationMs: Date.now() - startedAt,
                ...(spawnError ? { spawnError } : {})
            });
        };

        try {
            child = spawn(shellSpec.bin, invocation.args, {
                cwd,
                detached: process.platform !== 'win32',
                windowsHide: true,
                windowsVerbatimArguments: invocation.verbatim,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    ...env,
                    ...(stdinPayload ? {} : { ZHUIXUN_HOOK_INPUT: truncate(body, MAX_ENV_PAYLOAD_CHARS) })
                }
            });
        } catch (error) {
            finish(null, error instanceof Error ? error.message : String(error));
            return;
        }
        collect(child.stdout, stdout);
        collect(child.stderr, stderr);
        // hook 不读 stdin 就退出时写入会 EPIPE，结果以退出码为准
        child.stdin?.on('error', () => {});
        child.stdin?.end(stdinPayload ? body : invocation.stdin);
        child.on('error', (error) => finish(null, error.message));
        child.on('close', (code) => finish(timedOut ? null : code));
        timer = setTimeout(() => {
            timedOut = true;
            killProcessGroup(child);
            grace = setTimeout(() => finish(null), KILL_GRACE_MS);
        }, hook.timeout * 1000);
    });
}

/** 单个 hook 的结论。 */
interface HookOutcome {
    decision: 'allow' | 'deny' | 'ask' | 'none';
    failed: boolean;
    reason?: string;
    additionalContext?: string;
}

/** 解析 hook 输出：exit 0 + JSON → 按字段；exit 2 → 阻断（stderr 为原因）；其它 → 故障。 */
export function interpretExecution(exec: HookExecution): HookOutcome {
    if (exec.exitCode === 2) return { decision: 'deny', failed: false, reason: exec.stderr.trim() || undefined };
    if (exec.exitCode !== 0) {
        const why = exec.timedOut
            ? '执行超时'
            : exec.spawnError
              ? `无法启动（${exec.spawnError}）`
              : `退出码 ${exec.exitCode}${exec.stderr.trim() ? `：${truncate(exec.stderr.trim(), 300)}` : ''}`;
        return { decision: 'ask', failed: true, reason: `hook ${why}` };
    }
    const text = exec.stdout.trim();
    if (!text.startsWith('{')) return { decision: 'none', failed: false };
    try {
        const parsed = JSON.parse(text) as { decision?: unknown; reason?: unknown; additionalContext?: unknown };
        const decision =
            parsed.decision === 'allow' || parsed.decision === 'deny' || parsed.decision === 'ask'
                ? parsed.decision
                : 'none';
        return {
            decision,
            failed: false,
            ...(typeof parsed.reason === 'string' && parsed.reason ? { reason: parsed.reason } : {}),
            ...(typeof parsed.additionalContext === 'string' && parsed.additionalContext
                ? { additionalContext: parsed.additionalContext }
                : {})
        };
    } catch {
        return { decision: 'none', failed: false };
    }
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

let auditChain: Promise<void> = Promise.resolve();

function recordHookAudit(entry: HookAuditEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    auditChain = auditChain
        .then(async () => {
            await fsp.mkdir(paths.auditDir(), { recursive: true });
            await fsp.appendFile(paths.hooksAuditFile(), line, 'utf8');
        })
        .catch((error: unknown) => log.warn('hooks 审计写入失败', { err: error }));
}

/** 测试用：等待审计队列落盘。 */
export function flushHookAudit(): Promise<void> {
    return auditChain;
}

/** 读取最近 limit 条执行记录（新在前）；文件不存在返回空。 */
export async function readHookAudit(limit = 50): Promise<HookAuditEntry[]> {
    let raw: string;
    try {
        raw = await fsp.readFile(paths.hooksAuditFile(), 'utf8');
    } catch {
        return [];
    }
    const out: HookAuditEntry[] = [];
    const lines = raw.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
            out.push(JSON.parse(lines[i]) as HookAuditEntry);
        } catch {
            /* 损坏行跳过 */
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 运行器
// ---------------------------------------------------------------------------

function matching(entries: HookEntry[], toolName?: string): Array<{ entry: HookEntry; hook: HookCommand }> {
    const out: Array<{ entry: HookEntry; hook: HookCommand }> = [];
    for (const entry of entries) {
        if (toolName !== undefined && entry.pattern && !entry.pattern.test(toolName)) continue;
        for (const hook of entry.hooks) out.push({ entry, hook });
    }
    return out;
}

function inputPath(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const rec = input as Record<string, unknown>;
    const raw = rec.file_path ?? rec.path;
    return typeof raw === 'string' && raw ? raw : undefined;
}

export interface HookRunner extends ToolHookRunner {
    /** Stop：本轮结束后执行，结果只审计不回传。 */
    stop(input: { stopReason?: string; lastAssistantText?: string }): Promise<void>;
}

/**
 * 为一次会话轮创建 hook 运行器（实现 agent 层的 ToolHookRunner 端口）。
 * 每次调用都重新读取配置与信任状态：hooks.json 被改或总开关关闭后立即停止执行。
 */
export function createHookRunner(ctx: HookRunContext = {}): HookRunner {
    const cwd = ctx.cwd || WORKSPACE_DIR;

    const run = async (
        event: HookEventName,
        toolName: string | undefined,
        payload: Record<string, unknown>,
        extraEnv: Record<string, string>
    ) => {
        const config = activeHooksConfig();
        const targets = config ? matching(config[event], toolName) : [];
        if (targets.length === 0) return [];
        if (!ctx.cwd) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
        const env = {
            ZHUIXUN_HOOK_EVENT: event,
            ...(toolName ? { ZHUIXUN_TOOL_NAME: toolName } : {}),
            ...extraEnv
        };
        const body = { event, sessionId: ctx.sessionId, projectId: ctx.projectId, cwd, ...payload };
        // 同一事件的多个 hook 并行执行，结论按配置顺序合并
        return Promise.all(
            targets.map(async ({ entry, hook }) => {
                const exec = await executeHookCommand(hook, body, env, cwd);
                const outcome = interpretExecution(exec);
                recordHookAudit({
                    ts: dayjs().toISOString(),
                    event,
                    ...(toolName ? { toolName } : {}),
                    ...(entry.matcher ? { matcher: entry.matcher } : {}),
                    command: hook.command.slice(0, AUDIT_COMMAND_MAX),
                    exitCode: exec.exitCode,
                    durationMs: exec.durationMs,
                    ...(exec.timedOut ? { timedOut: true } : {}),
                    decision: outcome.failed ? 'error' : outcome.decision
                });
                if (outcome.failed) log.warn('hook 执行失败', { event, toolName, reason: outcome.reason });
                return outcome;
            })
        );
    };

    const toolEnv = (call: HookToolCall): Record<string, string> => {
        if (call.toolName !== 'Write' && call.toolName !== 'Edit') return {};
        const raw = inputPath(call.input);
        return raw ? { ZHUIXUN_FILE_PATH: path.resolve(cwd, raw) } : {};
    };

    return {
        matches(event, toolName) {
            const config = activeHooksConfig();
            return !!config && matching(config[event], toolName).length > 0;
        },

        async pre(call): Promise<HookVerdict> {
            const outcomes = await run(
                'PreToolUse',
                call.toolName,
                { toolName: call.toolName, toolInput: call.input },
                toolEnv(call)
            );
            const reasons = outcomes.map((o) => o.reason).filter((r): r is string => !!r);
            const reason = reasons.length > 0 ? reasons.join('；') : undefined;
            const withReason = (v: HookVerdict): HookVerdict => (reason ? { ...v, reason } : v);
            if (outcomes.some((o) => o.decision === 'deny')) return withReason({ decision: 'deny' });
            if (outcomes.some((o) => o.decision === 'ask')) {
                const failed =
                    outcomes.some((o) => o.failed) && !outcomes.some((o) => !o.failed && o.decision === 'ask');
                return withReason({ decision: 'ask', ...(failed ? { failed: true } : {}) });
            }
            if (outcomes.some((o) => o.decision === 'allow')) return withReason({ decision: 'allow' });
            return { decision: 'none' };
        },

        async post(call, output): Promise<HookPostResult> {
            const outcomes = await run(
                'PostToolUse',
                call.toolName,
                { toolName: call.toolName, toolInput: call.input, toolOutput: stringifyOutput(output) },
                toolEnv(call)
            );
            // 后置 hook 故障只告警，不影响工具结果
            const ok = outcomes.filter((o) => !o.failed);
            const blocked = ok.find((o) => o.decision === 'deny');
            const contexts = ok.map((o) => o.additionalContext).filter((c): c is string => !!c);
            return {
                ...(blocked ? { blocked: true, ...(blocked.reason ? { reason: blocked.reason } : {}) } : {}),
                ...(contexts.length > 0 ? { additionalContext: contexts.join('\n') } : {})
            };
        },

        async stop(input) {
            await run(
                'Stop',
                undefined,
                {
                    stopReason: input.stopReason,
                    lastAssistantText: input.lastAssistantText
                        ? truncate(input.lastAssistantText, MAX_LAST_TEXT_CHARS)
                        : ''
                },
                {}
            );
        }
    };
}
