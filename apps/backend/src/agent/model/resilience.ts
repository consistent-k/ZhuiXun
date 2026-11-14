/**
 * 模型调用韧性：可重试判定、退避、面向用户的错误文案。
 *
 * 两段分治（见 docs/fe-workflow/harness-engine-gaps/tech-design.md §3.1）：
 * - 请求建立阶段（拿到响应头前）：交给 AI SDK 自带的 `maxRetries`（指数退避、尊重 retry-after）。
 * - 流已开始、首个确定性 part 前：由 `withPreOutputRecovery` 的重试处理器兜底（本文件的 {@link createRetryHandler}）。
 * 一旦已向前端下发正文/推理/工具调用就不再自动重试，避免半截输出重复、工具副作用被重放。
 *
 * 不做 provider 降级链（2026-10-27 已确认）：重试耗尽后给出可读错误，由用户手动切换模型。
 */
import { APICallError, RetryError } from 'ai';

import { isContextOverflowError } from '@/agent/compaction/overflow-error';
import type { PreOutputRecoveryHandler } from '@/agent/compaction/reactive-stream';

/** 与 @ai-sdk/provider-utils 一致的可重试网络错误码（连接被重置 / 超时等，换个时机通常能成功）。 */
const RETRYABLE_NETWORK_CODES = new Set([
    'ConnectionRefused',
    'ConnectionClosed',
    'FailedToOpenSocket',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT'
]);

/** 流内重试的默认退避（毫秒）；数组长度即最大重试次数。 */
export const STREAM_RETRY_DELAYS_MS = [1000, 3000] as const;

interface ErrorFacts {
    statusCode?: number;
    isRetryable?: boolean;
    type?: string;
    name?: string;
    code?: string;
}

/** 从 SDK / provider 流错误 / 网络错误里抽取判定所需的字段（不同形态字段名不一）。 */
function factsOf(error: unknown): ErrorFacts {
    if (APICallError.isInstance(error)) {
        return { statusCode: error.statusCode, isRetryable: error.isRetryable, name: error.name };
    }
    if (typeof error === 'object' && error !== null) {
        const e = error as Record<string, unknown>;
        return {
            statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined,
            isRetryable: typeof e.isRetryable === 'boolean' ? e.isRetryable : undefined,
            type: typeof e.type === 'string' ? e.type : undefined,
            name: typeof e.name === 'string' ? e.name : undefined,
            code: typeof e.code === 'string' ? e.code : undefined
        };
    }
    return {};
}

/** 沿 cause 链查找可重试网络错误码（fetch 失败时真实原因藏在 cause 里）。 */
function hasRetryableNetworkCode(error: unknown): boolean {
    const visited = new Set<unknown>();
    let current: unknown = error;
    while (typeof current === 'object' && current !== null && !visited.has(current)) {
        visited.add(current);
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code)) return true;
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

/** 是否为用户主动停止（不能重试，否则「停止」会被吞掉）。 */
function isAbort(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'AbortError' || name === 'ResponseAborted';
}

/**
 * 流内（首个确定性 part 前）是否值得自动重试。
 *
 * - `RetryError` 不重试：它表示 AI SDK 已在请求建立阶段按 maxRetries 重试耗尽，再叠一层会把等待放大数倍。
 * - 超窗错误不重试：交给反应式压缩处理器（同一份 prompt 重发必然再次超窗）。
 * - 用户停止不重试。
 */
export function isRetryableModelError(error: unknown): boolean {
    if (error === undefined || error === null) return false;
    if (RetryError.isInstance(error)) return false;
    if (isAbort(error) || isContextOverflowError(error)) return false;
    const facts = factsOf(error);
    if (facts.isRetryable === true) return true;
    if (facts.isRetryable === false) return false;
    // timeoutFetch 在首个响应头前超时抛出 TimeoutError（见 agent/model/provider.ts）
    if (facts.name === 'TimeoutError') return true;
    if (facts.type === 'overloaded_error' || facts.type === 'rate_limit_error' || facts.type === 'api_error') {
        return true;
    }
    if (facts.statusCode !== undefined) {
        return facts.statusCode === 408 || facts.statusCode === 429 || facts.statusCode >= 500;
    }
    return hasRetryableNetworkCode(error);
}

/**
 * 把模型调用错误翻译成面向用户的可读文案；无法归类返回 undefined（调用方回落原始错误信息）。
 * 只按状态码 / 错误类型归类，不回显 provider 响应体（可能含请求内容）。
 */
export function describeModelError(error: unknown): string | undefined {
    const target = RetryError.isInstance(error) ? error.lastError : error;
    if (target === undefined || target === null || isAbort(target) || isContextOverflowError(target)) return undefined;
    const { statusCode, type, name } = factsOf(target);
    if (statusCode === 401 || statusCode === 403 || type === 'authentication_error' || type === 'permission_error') {
        return '模型密钥无效或无权限，请在「设置 → 模型配置」检查 API Key 与访问权限';
    }
    if (statusCode === 404 || type === 'not_found_error') {
        return '模型不存在或已下线，请在「设置 → 模型配置」检查模型名';
    }
    if (isRetryableModelError(target) || RetryError.isInstance(error) || name === 'TimeoutError') {
        return '模型服务暂不可用（限流、过载或网络异常），已自动重试仍失败。可稍后点击「重试」，或在「设置 → 模型配置」切换模型';
    }
    return undefined;
}

/** 可被 abort 打断的等待；打断时以 abort reason 拒绝，交由上层按停止处理。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** 重试事件：供 service 下发瞬态 `data-retry` 给前端展示「正在重试」。 */
export interface RetryEvent {
    attempt: number;
    max: number;
    delayMs: number;
    reason: string;
}

export interface RetryHandlerOptions {
    /** 每次重试前的退避；长度即最大重试次数。 */
    delaysMs?: readonly number[];
    /** 即将等待重试时回调。 */
    onRetry?: (event: RetryEvent) => void;
    /** 重试后的新流产出首个 part 时回调（前端据此收起「正在重试」）。 */
    onRecovered?: () => void;
}

/** 错误的简短原因（日志 / 前端提示用，不含响应体）。 */
export function retryReasonOf(error: unknown): string {
    const { statusCode, type, name, code } = factsOf(error);
    return [statusCode, type, code, name].filter((v) => v !== undefined && v !== '').join(' ') || 'unknown';
}

async function* notifyOnFirst<T>(source: AsyncIterable<T>, onFirst?: () => void): AsyncGenerator<T> {
    let notified = false;
    for await (const part of source) {
        if (!notified) {
            notified = true;
            onFirst?.();
        }
        yield part;
    }
}

/**
 * 首个确定性 part 前的「可重试错误」处理器：按退避等待后用同一份 options 重新发起流式。
 * 等待期间用户点击停止会立即结束（sleep 监听 options.abortSignal）。
 */
export function createRetryHandler(opts: RetryHandlerOptions = {}): PreOutputRecoveryHandler {
    const delays = opts.delaysMs ?? STREAM_RETRY_DELAYS_MS;
    return {
        id: 'retryable',
        maxAttempts: delays.length,
        matches: isRetryableModelError,
        recover: async ({ options, error, attempt, restream }) => {
            const delayMs = delays[attempt - 1] ?? delays.at(-1) ?? 0;
            opts.onRetry?.({ attempt, max: delays.length, delayMs, reason: retryReasonOf(error) });
            await sleep(delayMs, options.abortSignal as AbortSignal | undefined);
            const stream = await restream(options);
            return { stream: notifyOnFirst(stream, opts.onRecovered), options };
        }
    };
}
