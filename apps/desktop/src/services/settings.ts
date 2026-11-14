import type { ModelMeta, ProviderKind, ProviderView, WebSettingsPatch, WebSettingsView } from '@zhuixun/shared';

import type { PersonaSettingsPayload } from '@/services/persona';
import request, { type BaseResponse } from '@/utils/request';

/** 契约 DTO（provider 接入类型、脱敏视图、模型元信息、Web 设置）复用 @zhuixun/shared，这里转发并补充前端写入用的本地类型。 */
export type { ModelMeta, ProviderKind, ProviderView, WebSettingsPatch, WebSettingsView };

/** 单个模型 provider 配置（写入用；apiKey 留空表示保留后端已存密钥） */
export interface ProviderConfig {
    name: string;
    kind: ProviderKind;
    baseURL: string;
    apiKey?: string;
    models: string[];
    /** 每模型元信息映射，key 须等于 models 中的模型名；目前仅含 contextWindow */
    modelMeta?: Record<string, ModelMeta>;
}

/** GET /api/settings/model 返回体：全部 provider + 当前激活模型。每模型 contextWindow 经 ProviderView.modelMeta[modelName] 承载 */
export interface ModelConfigView {
    providers: ProviderView[];
    /** 当前激活模型，格式 `providerName/modelName` */
    activeModel?: string;
}

/** 对话加载模式：routed（全量工具）| progressive（按需加载，省上下文） */
export type AgentMode = 'routed' | 'progressive';

/** 应用级偏好（后端 settings.json `app` 段） */
export interface AppSettingsView {
    defaultAgentMode: AgentMode;
    /** 是否开启问答过程中的上下文自动压缩（类 Claude Code /compact） */
    autoCompactEnabled: boolean;
    /** 触发自动压缩的阈值（占模型上下文窗口的百分比，整数 50~95） */
    autoCompactThreshold: number;
    /** 主 agent 单轮最大步数（10~200），触顶即停并提示「继续」 */
    maxAgentSteps: number;
    /** 同一工具连续同错 / 同调用的熔断阈值（2~10） */
    repeatErrorLimit: number;
    /** 模型请求失败的自动重试次数（0~5） */
    modelMaxRetries: number;
    /** 是否为 Anthropic 模型开启 prompt 缓存 */
    promptCaching: boolean;
}

/** 导入/导出的整份配置（apiKey 导出时被抹除；导入时空 apiKey 保留后端已存密钥） */
export interface SettingsPayload {
    model?: { providers?: ProviderConfig[]; activeModel?: string };
    /** 导出时值被抹成空串，只保留键名 */
    env?: Record<string, string>;
    app?: Partial<AppSettingsView>;
    persona?: PersonaSettingsPayload;
    memory?: { enabled?: boolean; autoExtract?: boolean; autoDream?: boolean };
    web?: Record<string, unknown>;
}

/** 获取全部 provider + 激活模型（真源在后端 settings.json；apiKey 不下发，仅返回 configured 标记） */
export function fetchModelConfigApi(): Promise<BaseResponse<ModelConfigView>> {
    return request.get('/api/settings/model');
}

/** 新增 provider（落盘 settings.json） */
export function createProviderApi(data: ProviderConfig): Promise<BaseResponse<ProviderView>> {
    return request.post('/api/settings/providers', { data });
}

/** 更新 provider；apiKey 留空表示保留后端已存密钥，改名会联动改写激活模型引用 */
export function updateProviderApi(name: string, patch: Partial<ProviderConfig>): Promise<BaseResponse<ProviderView>> {
    return request.put(`/api/settings/providers/${encodeURIComponent(name)}`, { data: patch });
}

/** 删除 provider（若激活模型指向它则一并清空） */
export function deleteProviderApi(name: string): Promise<BaseResponse<{ deleted: boolean }>> {
    return request.delete(`/api/settings/providers/${encodeURIComponent(name)}`);
}

/** 设置当前激活模型（`providerName/modelName`），下一轮对话即生效 */
export function setActiveModelApi(activeModel: string): Promise<BaseResponse<{ activeModel: string }>> {
    return request.put('/api/settings/model/active', { data: { activeModel } });
}

/** 连通性测试：用某 provider 的（或临时传入的）密钥 + 某模型发一次最小请求验证可用性 */
export function testProviderApi(
    name: string,
    body: { model?: string; apiKey?: string } = {}
): Promise<BaseResponse<{ ok: boolean; error?: string }>> {
    return request.post(`/api/settings/providers/${encodeURIComponent(name)}/test`, { data: body });
}

/** 获取应用级偏好 */
export function fetchAppSettingsApi(): Promise<BaseResponse<AppSettingsView>> {
    return request.get('/api/settings/app');
}

/** 保存应用级偏好 */
export function updateAppSettingsApi(patch: Partial<AppSettingsView>): Promise<BaseResponse<AppSettingsView>> {
    return request.put('/api/settings/app', { data: patch });
}

/** 导出整份配置（apiKey 与环境变量值已抹除） */
export function exportSettingsApi(): Promise<BaseResponse<SettingsPayload>> {
    return request.get('/api/settings/export');
}

/** 导入整份配置（与后端现有配置合并；env 段需重启后端才生效） */
export function importSettingsApi(
    data: SettingsPayload
): Promise<BaseResponse<{ imported: boolean; envNeedsRestart: boolean }>> {
    return request.post('/api/settings/import', { data });
}

/** 环境变量列表（后端只回键名，值不下发） */
export interface EnvKeysView {
    keys: string[];
}

/** 列出已配置的环境变量键名（settings.json env 段） */
export function listEnvApi(): Promise<BaseResponse<EnvKeysView>> {
    return request.get('/api/settings/env');
}

/** 设置单个环境变量：写入 settings.json 并立即注入 process.env，新对话即生效 */
export function setEnvVarApi(key: string, value: string): Promise<BaseResponse<{ configured: boolean }>> {
    return request.post('/api/settings/env', { data: { key, value } });
}

/** 删除单个环境变量 */
export function removeEnvVarApi(key: string): Promise<BaseResponse<{ removed: boolean }>> {
    return request.delete(`/api/settings/env/${encodeURIComponent(key)}`);
}

// ---------- Web 访问（settings.json web 段；本期仅 WebFetch）----------

/** 读取 Web 访问设置 */
export function fetchWebSettingsApi(): Promise<BaseResponse<WebSettingsView>> {
    return request.get('/api/settings/web');
}

/** 保存 Web 访问设置（浅合并） */
export function updateWebSettingsApi(patch: WebSettingsPatch): Promise<BaseResponse<WebSettingsView>> {
    return request.put('/api/settings/web', { data: patch });
}

/** 连通性测试：走与 WebFetch 相同的受控抓取链，返回是否可读与耗时 */
export function testWebFetchApi(url: string): Promise<BaseResponse<{ ok: boolean; detail: string; ms: number }>> {
    return request.post('/api/settings/web/test', { data: { url } });
}
