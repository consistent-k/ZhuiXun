import type { ModelConfigView } from '@/services';

/**
 * 常见模型上下文窗口兜底映射（token）。仅在用户未在设置里填 `contextWindow` 时使用。
 * key 为规整后的模型名子串（小写、去日期/版本后缀），value 为上下文窗口 token 数。
 * 匹配策略：规整后的 modelName 命中任一 key 子串即采用（取最先命中的，表按从具体到宽泛排列）。
 */
const BUILTIN_CONTEXT_WINDOWS: Array<[string, number]> = [
    // Anthropic Claude
    ['claude-opus-4', 200_000],
    ['claude-sonnet-4', 200_000],
    ['claude-haiku-4', 200_000],
    ['claude-3-7', 200_000],
    ['claude-3-5', 200_000],
    ['claude-3', 200_000],
    ['claude', 200_000],
    // OpenAI
    ['gpt-4.1', 1_000_000],
    ['gpt-4o', 128_000],
    ['o4', 200_000],
    ['o3', 200_000],
    ['o1', 200_000],
    ['gpt-4-turbo', 128_000],
    ['gpt-4-32k', 32_768],
    ['gpt-4', 8_192],
    ['gpt-3.5', 16_385],
    // DeepSeek
    ['deepseek-r1', 64_000],
    ['deepseek', 64_000],
    // Qwen
    ['qwen-max', 32_768],
    ['qwen-long', 1_000_000],
    ['qwen2.5', 131_072],
    ['qwen', 32_768],
    // Google Gemini
    ['gemini-1.5-pro', 2_000_000],
    ['gemini-1.5', 1_000_000],
    ['gemini-2', 1_000_000],
    ['gemini', 1_000_000],
    // Moonshot / Kimi
    ['moonshot-v1-128k', 131_072],
    ['moonshot-v1-32k', 32_768],
    ['moonshot', 131_072],
    ['kimi', 131_072]
];

/** 按模型名模糊匹配内置上下文窗口；无命中返回 undefined */
export function lookupBuiltinContextWindow(modelName: string): number | undefined {
    const norm = modelName.toLowerCase().trim();
    for (const [key, value] of BUILTIN_CONTEXT_WINDOWS) {
        if (norm.includes(key)) return value;
    }
    return undefined;
}

/**
 * 按激活模型引用解析其上下文窗口 token 上限。
 *
 * 优先取用户在设置里填的 `provider.modelMeta[modelName].contextWindow`；未填时按模型名
 * 模糊匹配内置映射兜底（{@link lookupBuiltinContextWindow}）；仍无则返回 `undefined`，
 * 供上层降级为「仅展示已用 token」。畸形入参一律 undefined，绝不抛异常。
 *
 * @param view GET /api/settings/model 返回的模型配置视图（可能未加载）
 * @param activeModel 激活模型引用，格式 `providerName/modelName`
 * @returns 上下文窗口上限（正整数）；无法解析时 undefined
 */
export function resolveContextWindow(
    view: ModelConfigView | undefined,
    activeModel: string | undefined
): number | undefined {
    if (!activeModel) return undefined;
    const i = activeModel.indexOf('/');
    if (i <= 0) return undefined;
    const providerName = activeModel.slice(0, i);
    const modelName = activeModel.slice(i + 1);
    if (!modelName) return undefined;
    const provider = view?.providers?.find((p) => p.name === providerName);
    const cw = provider?.modelMeta?.[modelName]?.contextWindow;
    if (typeof cw === 'number' && Number.isFinite(cw) && cw > 0) return cw;
    // 用户未配置：按模型名兜底
    return lookupBuiltinContextWindow(modelName);
}
