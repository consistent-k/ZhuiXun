import type {
    ApiResponse,
    ModelMeta,
    ProviderKind,
    ProviderView,
    WebApprovalPolicy,
    WebSettingsPatch,
    WebSettingsView
} from '@zhuixun/shared';

/** 跨 HTTP 的 DTO（响应信封、模型脱敏视图等）统一定义在 @zhuixun/shared，这里转发并补充后端内部 domain 类型。 */
export type {
    ApiResponse,
    ModelMeta,
    ProviderKind,
    ProviderView,
    WebApprovalPolicy,
    WebSettingsPatch,
    WebSettingsView
};

/**
 * 单个模型 provider 配置（服务端真源，apiKey 明文，永不回传前端）。
 * `name` 同时是唯一键与展示名，`activeModel` 以 `name/modelName` 引用它（对齐 MCP servers 按 name 键）。
 */
export interface ProviderConfig {
    name: string;
    kind: ProviderKind;
    baseURL: string;
    apiKey: string;
    /** 该 provider 下可选模型名列表。 */
    models: string[];
    /** 每模型元信息映射，key 须等于 models[] 中的 modelName；缺省 undefined。目前仅含 contextWindow。 */
    modelMeta?: Record<string, ModelMeta>;
}

/** 模型接入配置：多 provider 列表 + 当前激活模型选择器。settings.json `model` 段的新形态。 */
export interface ModelSettings {
    providers: ProviderConfig[];
    /** 当前激活模型，格式 `providerName/modelName`；未设置表示未选择。 */
    activeModel?: string;
}

/** 运行层已解析的扁平模型配置：createModel() 的唯一入参。 */
export interface ResolvedModel {
    kind: ProviderKind;
    baseURL: string;
    apiKey: string;
    modelName: string;
    /** 解析自 provider.modelMeta[modelName]?.contextWindow，供运行层 / 展示层读取上下文窗口上限。 */
    contextWindow?: number;
}
