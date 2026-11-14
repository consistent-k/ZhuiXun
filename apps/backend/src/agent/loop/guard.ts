/**
 * 主 agent 工具循环护栏：步数上限 + 连续同错 / 同调用熔断 + 熔断前的软纠偏提示。
 *
 * 为什么要显式设置：AI SDK 的 ToolLoopAgent 未传 `stopWhen` 时默认 `isStepCount(20)`，
 * 触顶只在服务端打一条 warning，前端与模型都不知道被截断（ai@7.0.154 `createDefaultStopCondition`）。
 * 这里改为显式条件，并把停止原因记进 `state`，由 chat service 写入 finish metadata 供前端提示「继续」。
 *
 * 判定只读 AI SDK 的 StepResult.content（tool-call / tool-result / tool-error），不依赖具体工具实现。
 */
import type { TurnStopReason } from '@zhuixun/shared';
import type { Instructions, StopCondition, ToolSet } from 'ai';

/** 护栏产生的停止原因（跨 HTTP 契约 TurnStopReason 的子集；`error` 由 chat service 判定）。 */
export type LoopStopReason = Exclude<TurnStopReason, 'error'>;

export interface LoopGuardOptions {
    /** 单轮最大步数。 */
    maxSteps: number;
    /** 连续同错 / 同调用达到该次数即停止（≥2）。 */
    repeatLimit: number;
}

/** 护栏运行态：一轮对话内累积，停止时写入 stopReason。 */
export interface LoopGuardState {
    stopReason?: LoopStopReason;
    /** 已完成的步数（最近一次评估时的 steps.length）。 */
    steps: number;
    /** 触发停止的工具名（重复类停止时）。 */
    toolName?: string;
}

export interface LoopGuard {
    stopWhen: Array<StopCondition<ToolSet>>;
    /** prepareStep 片段：达到「熔断前一次」时追加纠偏提示，其余返回 undefined。 */
    prepareStep: (input: {
        steps: readonly StepLike[];
        instructions?: Instructions;
    }) => { instructions: Instructions } | undefined;
    state: LoopGuardState;
}

/** StepResult 的最小结构：只读 content。 */
export interface StepLike {
    content?: ReadonlyArray<{ type: string; toolName?: string; input?: unknown; output?: unknown; error?: unknown }>;
}

interface ToolOutcome {
    toolName: string;
    /** 错误签名（归一化后）；成功调用为 undefined。 */
    errorSig?: string;
    /** 调用签名：工具名 + 入参 + 产出。 */
    callSig: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ABS_PATH_RE = /(?:[A-Za-z]:\\|\/)[^\s'"`:]+/g;
const NUMBER_RE = /\d+/g;

/**
 * 错误文本归一化：去掉 UUID、绝对路径、数字（时间戳 / 行号 / 耗时），只比较「错误本身」。
 * 宁可漏判不误判：误判只会提前停止，用户可点「继续」。
 */
export function normalizeErrorText(text: string): string {
    return text.slice(0, 200).replace(UUID_RE, '<id>').replace(ABS_PATH_RE, '<path>').replace(NUMBER_RE, '<n>').trim();
}

/** 稳定序列化（对象键排序），用于入参 / 产出比较；不可序列化时退化为 String。 */
export function stableStringify(value: unknown): string {
    try {
        return (
            JSON.stringify(value, (_key, v: unknown) => {
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    return Object.fromEntries(
                        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
                    );
                }
                return v;
            }) ?? 'undefined'
        );
    } catch {
        return String(value);
    }
}

function errorTextOf(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    return stableStringify(value);
}

/** 结构化失败产出：工具未抛错、但返回了 `{ error }` 或 `{ ok: false, code, message }`。 */
function structuredErrorOf(output: unknown): string | undefined {
    if (output && typeof output === 'object' && !Array.isArray(output)) {
        const { error, ok, code, message } = output as Record<string, unknown>;
        if (typeof error === 'string' && error) return error;
        // WebFetch 的业务失败以正常工具结果返回；严格校验失败标记和错误字段后，复用同错归一化与熔断。
        if (ok === false && typeof code === 'string' && code.trim() && typeof message === 'string' && message.trim()) {
            return `${code}: ${message}`;
        }
    }
    return undefined;
}

/** 把多步结果按时间顺序摊平为工具结果序列（同步内并行调用按出现顺序）。 */
function outcomesOf(steps: readonly StepLike[]): ToolOutcome[] {
    const outcomes: ToolOutcome[] = [];
    for (const step of steps) {
        for (const part of step.content ?? []) {
            if (!part.toolName) continue;
            if (part.type === 'tool-error') {
                const text = errorTextOf(part.error) ?? '';
                outcomes.push({
                    toolName: part.toolName,
                    errorSig: normalizeErrorText(text),
                    callSig: `${part.toolName}|${stableStringify(part.input)}|error:${text}`
                });
            } else if (part.type === 'tool-result') {
                const structured = structuredErrorOf(part.output);
                outcomes.push({
                    toolName: part.toolName,
                    errorSig: structured === undefined ? undefined : normalizeErrorText(structured),
                    callSig: `${part.toolName}|${stableStringify(part.input)}|${stableStringify(part.output)}`
                });
            }
        }
    }
    return outcomes;
}

/** 末尾连续相同签名的长度。 */
function tailStreak(
    outcomes: ToolOutcome[],
    key: (o: ToolOutcome) => string | undefined
): { count: number; toolName?: string } {
    const last = outcomes.at(-1);
    const sig = last ? key(last) : undefined;
    if (!last || sig === undefined) return { count: 0 };
    let count = 0;
    for (let i = outcomes.length - 1; i >= 0; i--) {
        if (key(outcomes[i]) !== sig) break;
        count++;
    }
    return { count, toolName: last.toolName };
}

const errorKey = (o: ToolOutcome) => (o.errorSig === undefined ? undefined : `${o.toolName}|${o.errorSig}`);
const callKey = (o: ToolOutcome) => o.callSig;

/** 当前的重复情况：同错与同调用两类取较大者。 */
export function repetitionOf(steps: readonly StepLike[]): {
    kind?: 'repeated-error' | 'repeated-call';
    count: number;
    toolName?: string;
} {
    const outcomes = outcomesOf(steps);
    const error = tailStreak(outcomes, errorKey);
    const call = tailStreak(outcomes, callKey);
    if (error.count === 0 && call.count === 0) return { count: 0 };
    // 同调用（入参与产出都相同）比同错更具体：计数相同时优先报同错（对用户更好理解）
    return error.count >= call.count
        ? { kind: 'repeated-error', count: error.count, toolName: error.toolName }
        : { kind: 'repeated-call', count: call.count, toolName: call.toolName };
}

/** 给已有 instructions 末尾追加一段临时提示（不改动原值，兼容 string / 系统消息 / 数组三种形态）。 */
export function appendInstructions(instructions: Instructions | undefined, hint: string): Instructions {
    if (instructions === undefined) return hint;
    if (typeof instructions === 'string') return `${instructions}\n\n${hint}`;
    const list = Array.isArray(instructions) ? instructions : [instructions];
    return [...list, { role: 'system', content: hint }];
}

function correctionHint(kind: 'repeated-error' | 'repeated-call', count: number, toolName?: string): string {
    const what = kind === 'repeated-error' ? `连续失败 ${count} 次` : `以相同参数连续调用 ${count} 次且结果相同`;
    return [
        '## 运行提示（系统）',
        `工具 ${toolName ?? ''} 已${what}。不要再以相同方式重试：请换一种方法，`,
        '或停止调用工具，直接向用户说明遇到的阻塞与需要用户提供的信息。'
    ].join('\n');
}

/**
 * 创建一轮对话的护栏。每轮对话新建一个（state 不跨轮复用）。
 *
 * @param opts 步数上限与重复阈值（已由 config 层 clamp）
 */
export function createLoopGuard(opts: LoopGuardOptions): LoopGuard {
    const state: LoopGuardState = { steps: 0 };
    const limit = Math.max(2, opts.repeatLimit);

    const maxSteps: StopCondition<ToolSet> = ({ steps }) => {
        state.steps = steps.length;
        if (steps.length < opts.maxSteps) return false;
        state.stopReason = 'max-steps';
        return true;
    };

    const repeated: StopCondition<ToolSet> = ({ steps }) => {
        const rep = repetitionOf(steps as unknown as StepLike[]);
        if (!rep.kind || rep.count < limit) return false;
        state.stopReason = rep.kind;
        state.toolName = rep.toolName;
        return true;
    };

    return {
        // 重复检测排在步数之前：两者同时满足时报更具体的原因
        stopWhen: [repeated, maxSteps],
        prepareStep: ({ steps, instructions }) => {
            const rep = repetitionOf(steps);
            if (!rep.kind || rep.count !== limit - 1) return undefined;
            return {
                instructions: appendInstructions(instructions, correctionHint(rep.kind, rep.count, rep.toolName))
            };
        },
        state
    };
}
