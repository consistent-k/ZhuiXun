/** provider 接入类型：openai/anthropic/google 走原生 SDK，openai-compatible 走通用兼容适配器。 */
export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible';

/**
 * 单模型元信息（与 provider.models[] 并行的映射，key = 模型名）。
 * 目前仅承载上下文窗口上限，供会话 token 用量展示计算「剩余上下文」。
 */
export interface ModelMeta {
    /** 该模型上下文窗口 token 上限；缺省 undefined（未知模型 / 厂内网关不填即降级）。 */
    contextWindow?: number;
}

/** provider 脱敏视图（GET /api/settings/model 返回；无 apiKey，带 configured 标记）。 */
export interface ProviderView {
    name: string;
    kind: ProviderKind;
    baseURL: string;
    /** 该 provider 下可选模型名列表。 */
    models: string[];
    /** 每模型元信息映射（含 contextWindow），下游据此解析激活模型上下文窗口上限。 */
    modelMeta?: Record<string, ModelMeta>;
    /** 后端是否已配置该 provider 的密钥（密钥本身不下发）。 */
    configured: boolean;
}
