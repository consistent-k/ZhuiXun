import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
    extractReasoningMiddleware,
    wrapLanguageModel,
    type Instructions,
    type LanguageModel,
    type ModelMessage,
    type SystemModelMessage
} from 'ai';

import { RESPONSE_TIMEOUT_MS } from '@/config/model';
import type { ResolvedModel } from '@/config/types';

/**
 * 封装 fetch：
 * 1) 合并 AI SDK 传入的取消信号（init.signal），确保用户点击「停止」时上游请求被正确 abort；
 *    此前无条件覆盖 signal 会丢弃该信号，导致停止无效、上游继续运行。
 * 2) 超时只覆盖「首个响应到达前」：拿到响应后清除定时器，流式响应体不再受超时限制
 *    （避免大 EMR / 多工具轮次的正常长流被中途 abort）。
 */
function createTimeoutFetch(timeoutMs: number): typeof fetch {
    return async (input, init) => {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException('模型响应超时（未在限定时间内返回响应头）', 'TimeoutError')),
            timeoutMs
        );
        const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
        try {
            return await fetch(input, { ...init, signal });
        } finally {
            clearTimeout(timer);
        }
    };
}

const timeoutFetch = createTimeoutFetch(RESPONSE_TIMEOUT_MS);

export function createModel(model: ResolvedModel): LanguageModel {
    switch (model.kind) {
        case 'openai': {
            const openai = createOpenAI({
                baseURL: model.baseURL,
                apiKey: model.apiKey,
                fetch: timeoutFetch
            });
            return openai(model.modelName);
        }

        case 'anthropic': {
            const anthropic = createAnthropic({
                baseURL: model.baseURL,
                apiKey: model.apiKey,
                fetch: timeoutFetch
            });
            return anthropic(model.modelName);
        }

        case 'google': {
            // Google Gemini 走原生 @ai-sdk/google（生成式语言 API）。baseURL 缺省
            // https://generativelanguage.googleapis.com/v1beta，由前端预填，也可指向代理网关；
            // SDK 会自动拼 /models/<model>:generateContent 并用 x-goog-api-key 鉴权。
            const google = createGoogleGenerativeAI({
                baseURL: model.baseURL,
                apiKey: model.apiKey,
                fetch: timeoutFetch
            });
            return google(model.modelName);
        }

        case 'openai-compatible': {
            // 任意 OpenAI 兼容端点（DeepSeek / 千帆 / 通义 / one-api 网关 / 本地 Ollama 等）。
            // 用 createOpenAICompatible 而非 createOpenAI：后者假定严格 OpenAI 语义，
            // 对兼容网关容易出现不兼容；前者只按通用 chat/completions 协议对接。
            const compatible = createOpenAICompatible({
                name: 'openai-compatible',
                baseURL: model.baseURL,
                apiKey: model.apiKey,
                fetch: timeoutFetch
            });
            return wrapLanguageModel({
                model: compatible(model.modelName),
                middleware: extractReasoningMiddleware({ tagName: 'think' })
            });
        }

        default:
            throw new Error(`Unsupported provider kind: ${model.kind}`);
    }
}

/** Anthropic 显式缓存断点（5 分钟 ephemeral）；单请求上限 4 个，本项目只用 2 个（系统稳定前缀 + 历史末尾）。 */
const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const;

/** 是否需要显式打缓存断点：只有 Anthropic 需要，OpenAI / Google / 兼容网关走服务端自动前缀缓存。 */
export function usesExplicitPromptCache(kind: ResolvedModel['kind'], enabled: boolean): boolean {
    return enabled && kind === 'anthropic';
}

/**
 * 把「稳定前缀 + 易变后缀」组装成 agent 的 instructions。
 *
 * Anthropic 缓存顺序是 tools → system → messages，把断点打在稳定前缀末尾即可让工具定义与稳定系统提示
 * 一起命中缓存；易变段（记忆召回 / 日期 / 任务清单）放在断点之后，变化不影响前缀命中。
 * 其它 provider 返回拼接后的字符串，行为与改造前一致。
 */
export function toInstructions(
    parts: { stable: string; volatile: string },
    kind: ResolvedModel['kind'],
    caching: boolean
): Instructions {
    if (!usesExplicitPromptCache(kind, caching)) {
        return [parts.stable, parts.volatile].filter((p, i) => i === 0 || p).join('\n\n');
    }
    const messages: SystemModelMessage[] = [
        { role: 'system', content: parts.stable, providerOptions: ANTHROPIC_CACHE }
    ];
    if (parts.volatile) messages.push({ role: 'system', content: parts.volatile });
    return messages;
}

/**
 * prepareStep 片段：给本步输入的最后一条消息打缓存断点（Anthropic）。
 * 多步工具循环中每一步都把「到目前为止的全部历史」写入缓存，下一步只需为新增的工具结果付费。
 * 不修改原消息对象（AI SDK 会复用历史消息数组）。
 */
export function markLastMessageForCache({
    messages
}: {
    messages: ModelMessage[];
}): { messages: ModelMessage[] } | undefined {
    const last = messages.at(-1);
    if (!last || last.role === 'system') return undefined;
    const marked = {
        ...last,
        providerOptions: {
            ...last.providerOptions,
            anthropic: { ...last.providerOptions?.anthropic, ...ANTHROPIC_CACHE.anthropic }
        }
    } as ModelMessage;
    return { messages: [...messages.slice(0, -1), marked] };
}
