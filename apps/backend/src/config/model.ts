/**
 * 模型配置门面。真源为 settings.json 的 `model` 段（见 config/settings-store）：
 * 多 provider 列表 + 激活模型选择器，此处只做转出。
 *
 * apiKey 始终留在后端、不经前端往返：settings 只透出 provider 的 `configured` 布尔，
 * chat 用激活模型（或单次请求指定的 `providerName/modelName`）在服务端解析出完整配置。
 */
import type { ResolvedModel } from '@/config/types';

import { resolveActiveModel, resolveModelRef } from './settings-store';

export type { ResolvedModel };

/** 解析当前激活模型为运行层配置；未选择或引用失效返回 null。 */
export function activeModel(): ResolvedModel | null {
    return resolveActiveModel();
}

/** 解析单次请求指定的 `providerName/modelName` 覆盖；不存在返回 null。 */
export function modelByRef(ref: string): ResolvedModel | null {
    return resolveModelRef(ref);
}

/**
 * 模型响应超时（仅覆盖「首个响应头到达前」）。openrouter/free 等自动路由别名可能挂起，
 * AI SDK 默认不设超时会导致前端无限 loading，这里作兜底。响应头返回后不再限制流式体。
 */
export const RESPONSE_TIMEOUT_MS = 60_000;
