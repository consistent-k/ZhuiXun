/**
 * settings.json 读写真源。取代 `.env` 成为运行时配置源：
 * - `model` 段：模型接入配置的**服务端真源**（typed + 运行时可变），供 config/model 委托读取。
 * - `env` 段：Claude Code 风格的环境变量透传，启动时对「尚未设置」的键注入 process.env，
 *   下游所有 config/* 访问器（端口 / 日志 / shell / 技能目录 / MCP 占位符解析等）零改动即可取值。
 *
 * 刻意用 `console.*` 而非结构化 logger：本模块处在启动引导链（bootstrap-settings 在 index.ts
 * 首行导入、早于任何 config 访问器求值），若引入 logging 会把 logging 模块提前拉起、破坏
 * 「env 先注入、logging 后加载」的时序（logging 的级别阈值在模块加载时解析一次）。同 config/paths。
 */
import fs from 'node:fs';

import { writeJsonAtomicSync } from '@/config/atomic-json';
import type {
    ModelMeta,
    ModelSettings,
    ProviderConfig,
    ProviderView,
    ResolvedModel,
    WebApprovalPolicy
} from '@/config/types';

import { paths } from './paths';

/** 对话加载模式：routed（全量工具）| progressive（按需加载，省上下文）。 */
export type AgentMode = 'routed' | 'progressive';

/** 应用级偏好（非模型、非 env 的结构化 app 设置）。 */
export interface AppPrefs {
    /** 默认对话加载模式；缺省 routed。 */
    defaultAgentMode?: AgentMode;
    /** 是否开启问答过程中的上下文自动压缩（类 Claude Code /compact）；缺省开启。 */
    autoCompactEnabled?: boolean;
    /** 触发自动压缩的阈值（占「上下文窗口扣除输出预留后」的有效窗口百分比，整数 50~95）；缺省 80。 */
    autoCompactThreshold?: number;
    /** 主 agent 单轮最大步数（10~200）；缺省 40。触顶即停并提示用户「继续」。 */
    maxAgentSteps?: number;
    /** 同一工具连续同错 / 同调用的熔断阈值（2~10）；缺省 3。 */
    repeatErrorLimit?: number;
    /** 模型请求建立阶段的自动重试次数（0~5，交给 AI SDK maxRetries）；缺省 3。 */
    modelMaxRetries?: number;
    /** 是否为支持的 provider（Anthropic）显式打 prompt cache 断点；缺省开启。 */
    promptCaching?: boolean;
    /** 连续自动唤醒（后台任务完成 / 自驱循环）上限，达上限改为排队等真人输入；缺省 3。 */
    maxConsecutiveWakes?: number;
    /** 自驱循环默认轮数上限（GoalArm 未指定时）；缺省 5。 */
    goalMaxRounds?: number;
}

/** 应用级偏好默认值与阈值区间。 */
export const APP_PREFS_DEFAULTS = {
    defaultAgentMode: 'routed' as AgentMode,
    autoCompactEnabled: true,
    autoCompactThreshold: 80,
    /** 阈值合法区间（整数百分比），超出则 clamp。 */
    autoCompactThresholdMin: 50,
    autoCompactThresholdMax: 95,
    maxAgentSteps: 40,
    maxAgentStepsMin: 10,
    maxAgentStepsMax: 200,
    repeatErrorLimit: 3,
    repeatErrorLimitMin: 2,
    repeatErrorLimitMax: 10,
    modelMaxRetries: 3,
    modelMaxRetriesMin: 0,
    modelMaxRetriesMax: 5,
    promptCaching: true,
    maxConsecutiveWakes: 3,
    maxConsecutiveWakesMin: 1,
    maxConsecutiveWakesMax: 20,
    goalMaxRounds: 5,
    goalMaxRoundsMin: 1,
    goalMaxRoundsMax: 50
} as const;

/** 渠道配置段（settings.json 的 channels）。所有渠道均为插件，enable 与否由 plugins 允许列表决定。 */
export interface ChannelsSettings {
    /** 渠道插件允许列表——`~/.zhuixun/channels/plugins/<id>/` 下的目录 id（导出 register(manager, ctx)）。 */
    plugins?: string[];
}

/** SkillHub 技能广场配置段（settings.json 的 skillhub）。真源在后端，前端经 /api/skillhub/config 读写。 */
export interface SkillhubSettings {
    /** SkillHub API 基址，默认 https://api.skillhub.cn。只应指向可信服务。 */
    apiBase?: string;
    /** 搜索结果每批上限，默认 12。 */
    maxResults?: number;
    /** 上游请求超时（毫秒），默认 20000。 */
    timeoutMs?: number;
}

/** 记忆配置段（settings.json 的 memory）。多文件记忆的真源仍是磁盘文件，此处只存全局开关类偏好。 */
export interface MemorySettings {
    /** 记忆总开关；缺省开启。关闭则不注入、不挂工具、不沉淀/整理。 */
    enabled?: boolean;
    /** 每轮结束后自动沉淀（抽取）；缺省开启。 */
    autoExtract?: boolean;
    /** 周期自动整理（dream）；缺省开启。 */
    autoDream?: boolean;
}

/** 记忆配置默认值。 */
export const MEMORY_DEFAULTS: Required<MemorySettings> = {
    enabled: true,
    autoExtract: true,
    autoDream: true
};

/** 自定义风格记录（settings.json persona.custom 的落盘形态）。内置风格不落盘，见 modules/persona/presets。 */
export interface PersonaRecord {
    id: string;
    name: string;
    description: string;
    instruction: string;
    createdAt: number;
    updatedAt: number;
}

/** 智能体风格配置段（settings.json 的 persona）。 */
export interface PersonaSettings {
    /** 默认风格 id；缺省或失效时由 modules/persona 回落到 default。 */
    defaultId?: string;
    /** 用户自建风格；内置风格由代码提供，不写入此处。 */
    custom?: PersonaRecord[];
}

/**
 * Web 访问配置段（settings.json 的 web）。
 * 本期只覆盖 WebFetch；搜索字段在 WebSearch 阶段再新增。
 */
export interface WebSettings {
    enabled?: boolean;
    fetchEnabled?: boolean;
    allowedHosts?: string[];
    blockedHosts?: string[];
    requireApproval?: WebApprovalPolicy;
    timeoutMs?: number;
    maxBytes?: number;
    maxChars?: number;
}

/** Web 访问默认值：抓取开箱可用；审批默认自动放行（只读、无本地副作用）。 */
export const WEB_DEFAULTS: Required<WebSettings> = {
    enabled: true,
    fetchEnabled: true,
    allowedHosts: [],
    blockedHosts: [],
    requireApproval: 'never',
    timeoutMs: 15000,
    // 仅调整缺省值；已保存或导入的显式值仍由 getWebSettings 按原合法区间读取，不做迁移。
    maxBytes: 5 * 1024 * 1024,
    maxChars: 20000
};

/** Web 配置的合法区间：更新时统一 clamp，避免前端传入异常值把抓取卡死。 */
export const WEB_LIMITS = {
    timeoutMsMin: 1000,
    timeoutMsMax: 60_000,
    maxBytesMin: 64 * 1024,
    maxBytesMax: 10 * 1024 * 1024,
    maxCharsMin: 1000,
    maxCharsMax: 100_000,
    hostsMax: 200
} as const;

/** 应用配置：settings.json 的内存映射。 */
export interface AppSettings {
    /** 模型接入配置（服务端真源，apiKey 明文，永不回传前端）。多 provider + 激活选择。 */
    model?: ModelSettings;
    /** 环境变量透传段：启动时对未设置的键注入 process.env。 */
    env?: Record<string, string>;
    /** 应用级偏好（默认对话模式等）。 */
    app?: AppPrefs;
    /** 渠道（IM 接入）配置段。 */
    channels?: ChannelsSettings;
    /** SkillHub 技能广场配置段。 */
    skillhub?: SkillhubSettings;
    /** 记忆配置段。 */
    memory?: MemorySettings;
    /** 智能体风格配置段。 */
    persona?: PersonaSettings;
    /** Web 访问配置段（本期仅 WebFetch）。 */
    web?: WebSettings;
    /**
     * Hooks 信任与开关（hooks.json 本身只手工编辑）。**不参与导入导出**：
     * 否则导入一份配置即可绕过「用户在本机确认过当前文件 hash」的信任闸口。
     */
    hooks?: HooksSettings;
}

/** Hooks 设置段。 */
export interface HooksSettings {
    /** 总开关，缺省关闭 */
    enabled?: boolean;
    /** 用户确认过的 hooks.json 内容 sha256；与当前文件不一致时全部 hooks 不执行 */
    trustedHash?: string;
}

/**
 * 安全敏感环境变量：**禁止**经 settings.json 的 env 段注入 process.env。
 * 前端可写 settings.json，若允许注入这些键，等于让前端打开危险模式 / 关鉴权 / 放开 CORS。
 * 危险跳过审批模式只认 CLI 与真实 env（见 config/danger-mode.ts），这些键必须继续走真实环境变量 / CLI。
 */
export const SENSITIVE_ENV_KEYS = ['ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS', 'API_AUTH_TOKEN', 'ALLOWED_ORIGINS'];

/** 进程级缓存：undefined 表示尚未加载。 */
let cache: AppSettings | undefined;

/** settings.json 绝对路径（SETTINGS_CONFIG_PATH 可覆盖，见 config/paths）。 */
function settingsFile(): string {
    return paths.settingsPath();
}

/**
 * 同步读取 settings.json（供 bootstrap 在 port() 之前经 getSettings 调用）。
 * 文件不存在或坏 JSON 时回落空配置并告警，不抛错（对齐 loadMCPConfig 的容错降级）。
 */
function loadSettings(): AppSettings {
    const file = settingsFile();
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as AppSettings;
        cache = {
            model: raw.model,
            env: raw.env ?? {},
            app: raw.app ?? {},
            channels: raw.channels ?? {},
            skillhub: raw.skillhub ?? {},
            memory: raw.memory ?? {},
            persona: raw.persona ?? {},
            web: raw.web ?? {},
            hooks: raw.hooks ?? {}
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[Settings] 读取 settings.json 失败，回落默认配置', {
                file,
                err: error instanceof Error ? error.message : error
            });
        }
        cache = { env: {}, app: {}, channels: {}, skillhub: {}, memory: {}, persona: {}, web: {}, hooks: {} };
    }
    return cache;
}

/** 返回缓存配置；未加载则先同步加载。 */
export function getSettings(): AppSettings {
    return cache ?? loadSettings();
}

/** 原子写 settings.json（0600：仅属主可读写，apiKey 明文落盘）。同步版仅因引导链必须同步。 */
function persist(settings: AppSettings): void {
    writeJsonAtomicSync(settingsFile(), settings, { mode: 0o600 });
}

/** 读取模型配置（多 provider）。settings.json 是唯一真源，无历史形态迁移。 */
export function getModelSettings(): ModelSettings {
    const model = getSettings().model;
    return { providers: model?.providers ?? [], activeModel: model?.activeModel };
}

/** 落盘并热更 model 段。 */
function saveModelSettings(model: ModelSettings): void {
    cache = { ...getSettings(), model };
    persist(cache);
}

/** 把 modelMeta 收敛为仅保留仍存在于 models[] 的键（避免删模型后残留孤儿条目）；空则返回 undefined。 */
function pruneModelMeta(
    models: string[],
    modelMeta: Record<string, ModelMeta> | undefined
): Record<string, ModelMeta> | undefined {
    if (!modelMeta) return undefined;
    const out: Record<string, ModelMeta> = {};
    for (const name of models) {
        const meta = modelMeta[name];
        if (meta && meta.contextWindow !== undefined) out[name] = meta;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function toView(p: ProviderConfig): ProviderView {
    return {
        name: p.name,
        kind: p.kind,
        baseURL: p.baseURL,
        models: p.models,
        modelMeta: p.modelMeta,
        configured: !!p.apiKey
    };
}

/** 把 `providerName/modelName` 解析为运行层扁平配置；provider 不存在或格式非法返回 null。 */
function resolveRef(settings: ModelSettings, ref: string): ResolvedModel | null {
    const i = ref.indexOf('/');
    if (i <= 0 || i === ref.length - 1) return null;
    const name = ref.slice(0, i);
    const modelName = ref.slice(i + 1);
    const p = settings.providers.find((x) => x.name === name);
    if (!p) return null;
    return {
        kind: p.kind,
        baseURL: p.baseURL,
        apiKey: p.apiKey,
        modelName,
        contextWindow: p.modelMeta?.[modelName]?.contextWindow
    };
}

/** 解析当前激活模型为运行层配置；未选择或引用失效返回 null。 */
export function resolveActiveModel(): ResolvedModel | null {
    const s = getModelSettings();
    return s.activeModel ? resolveRef(s, s.activeModel) : null;
}

/** 解析任意 `providerName/modelName` 引用（供单次请求覆盖）。 */
export function resolveModelRef(ref: string): ResolvedModel | null {
    return resolveRef(getModelSettings(), ref);
}

// MODEL_PROVIDER_CRUD

/** provider 操作异常码（routes 据此映射 HTTP 状态）。 */
export type ProviderErrorCode = 'DUPLICATE_PROVIDER' | 'PROVIDER_NOT_FOUND' | 'INVALID_ACTIVE_MODEL';
export class ProviderError extends Error {
    constructor(public code: ProviderErrorCode) {
        super(code);
    }
}

/** provider 列表（脱敏视图，无 apiKey）。 */
export function listProviders(): ProviderView[] {
    return getModelSettings().providers.map(toView);
}

/** 取单个 provider 完整配置（含 apiKey，仅服务端内部使用，如连通性测试）。 */
export function getProvider(name: string): ProviderConfig | undefined {
    return getModelSettings().providers.find((p) => p.name === name);
}

/** 新增 provider；name 冲突抛 DUPLICATE_PROVIDER。 */
export function addProvider(input: ProviderConfig): ProviderView {
    const settings = getModelSettings();
    if (settings.providers.some((p) => p.name === input.name)) {
        throw new ProviderError('DUPLICATE_PROVIDER');
    }
    const provider: ProviderConfig = {
        name: input.name,
        kind: input.kind,
        baseURL: input.baseURL,
        apiKey: input.apiKey ?? '',
        models: input.models ?? [],
        modelMeta: pruneModelMeta(input.models ?? [], input.modelMeta)
    };
    saveModelSettings({ ...settings, providers: [...settings.providers, provider] });
    return toView(provider);
}
// MODEL_PROVIDER_CRUD_2

/**
 * 更新 provider。空/缺省 apiKey 保留已存密钥；改名时同步改写 activeModel 前缀（避免引用断链）。
 * name 不存在抛 PROVIDER_NOT_FOUND；改名撞已有 name 抛 DUPLICATE_PROVIDER。
 */
export function updateProvider(name: string, patch: Partial<ProviderConfig>): ProviderView {
    const settings = getModelSettings();
    const idx = settings.providers.findIndex((p) => p.name === name);
    if (idx < 0) throw new ProviderError('PROVIDER_NOT_FOUND');
    const cur = settings.providers[idx];
    const nextName = patch.name ?? cur.name;
    if (nextName !== name && settings.providers.some((p) => p.name === nextName)) {
        throw new ProviderError('DUPLICATE_PROVIDER');
    }
    const nextModels = patch.models ?? cur.models;
    const merged: ProviderConfig = {
        name: nextName,
        kind: patch.kind ?? cur.kind,
        baseURL: patch.baseURL ?? cur.baseURL,
        apiKey: patch.apiKey ? patch.apiKey : cur.apiKey,
        models: nextModels,
        modelMeta: pruneModelMeta(nextModels, patch.modelMeta ?? cur.modelMeta)
    };
    const providers = [...settings.providers];
    providers[idx] = merged;
    let activeModel = settings.activeModel;
    if (nextName !== name && activeModel && activeModel.startsWith(`${name}/`)) {
        activeModel = `${nextName}/${activeModel.slice(name.length + 1)}`;
    }
    saveModelSettings({ providers, activeModel });
    return toView(merged);
}

/** 删除 provider；若 activeModel 指向它则一并清空。返回是否命中删除。 */
export function deleteProvider(name: string): boolean {
    const settings = getModelSettings();
    const providers = settings.providers.filter((p) => p.name !== name);
    if (providers.length === settings.providers.length) return false;
    const activeModel = settings.activeModel?.startsWith(`${name}/`) ? undefined : settings.activeModel;
    saveModelSettings({ providers, activeModel });
    return true;
}

/** 设置激活模型；provider 不存在或该模型不在其 models 列表内抛 INVALID_ACTIVE_MODEL。 */
export function setActiveModel(ref: string): string {
    const settings = getModelSettings();
    const i = ref.indexOf('/');
    const name = i > 0 ? ref.slice(0, i) : '';
    const modelName = i > 0 ? ref.slice(i + 1) : '';
    const p = settings.providers.find((x) => x.name === name);
    if (!p || !modelName || !p.models.includes(modelName)) {
        throw new ProviderError('INVALID_ACTIVE_MODEL');
    }
    saveModelSettings({ ...settings, activeModel: ref });
    return ref;
}

/**
 * 把 env 段注入 process.env：命中敏感 denylist、或键已存在（真实 env / 已注入者胜出）时跳过。
 * @param env settings.json 的 env 段
 */
export function applyEnvOverlay(env: Record<string, string> | undefined): void {
    if (!env) return;
    for (const [key, value] of Object.entries(env)) {
        if (SENSITIVE_ENV_KEYS.includes(key)) {
            console.warn(`[Settings] 忽略 settings.json env 中的敏感键（不注入 process.env）：${key}`);
            continue;
        }
        if (process.env[key] !== undefined) continue;
        // 空值是导入后「待填写」的占位（导出会抹掉 env 值），不注入，避免把空串当成已配置
        if (value === '') continue;
        process.env[key] = value;
    }
}

/** 用户可配置的环境变量键名规则：大写字母开头，仅大写字母/数字/下划线，最长 64。 */
const ENV_KEY_RULE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** 键名格式合法且不在安全敏感 denylist 时，才允许用户经 settings 面板设置。 */
export function isValidUserEnvKey(key: string): boolean {
    return ENV_KEY_RULE.test(key) && !SENSITIVE_ENV_KEYS.includes(key);
}

/** 列出 settings.json env 段已配置的键名（排序；只回键名，不回值，对齐 apiKey 的 configured 约定）。 */
export function listEnvKeys(): string[] {
    return Object.keys(getSettings().env ?? {}).sort();
}

/**
 * 设置单个环境变量：写入 settings.json env 段并落盘，同时**立即**注入 process.env（覆盖现值）。
 * 与 applyEnvOverlay 的「已存在则跳过」语义不同——这是用户显式设置，应即时生效、覆盖，故不走 overlay。
 * @throws 键名非法或命中安全敏感 denylist
 */
export function setEnvVar(key: string, value: string): void {
    if (!isValidUserEnvKey(key)) throw new Error(`非法或受保护的环境变量键名：${key}`);
    const settings = getSettings();
    cache = { ...settings, env: { ...(settings.env ?? {}), [key]: value } };
    persist(cache);
    process.env[key] = value;
}

/** 删除单个环境变量：从 settings.json env 段移除并落盘，同时从 process.env 删除（不存在则 no-op）。 */
export function removeEnvVar(key: string): void {
    const settings = getSettings();
    const env = { ...(settings.env ?? {}) };
    if (!(key in env)) return;
    delete env[key];
    cache = { ...settings, env };
    persist(cache);
    delete process.env[key];
}

/** 应用级偏好读取（含默认值兜底 + 阈值 clamp）。 */
export function getAppSettings(): Required<AppPrefs> {
    const app = getSettings().app ?? {};
    const rawThreshold = app.autoCompactThreshold;
    const threshold =
        Number.isFinite(rawThreshold) && (rawThreshold as number) > 0
            ? Math.min(
                  APP_PREFS_DEFAULTS.autoCompactThresholdMax,
                  Math.max(APP_PREFS_DEFAULTS.autoCompactThresholdMin, Math.round(rawThreshold as number))
              )
            : APP_PREFS_DEFAULTS.autoCompactThreshold;
    return {
        defaultAgentMode: app.defaultAgentMode === 'progressive' ? 'progressive' : 'routed',
        autoCompactEnabled:
            typeof app.autoCompactEnabled === 'boolean'
                ? app.autoCompactEnabled
                : APP_PREFS_DEFAULTS.autoCompactEnabled,
        autoCompactThreshold: threshold,
        maxAgentSteps: clampInt(
            app.maxAgentSteps,
            APP_PREFS_DEFAULTS.maxAgentSteps,
            APP_PREFS_DEFAULTS.maxAgentStepsMin,
            APP_PREFS_DEFAULTS.maxAgentStepsMax
        ),
        repeatErrorLimit: clampInt(
            app.repeatErrorLimit,
            APP_PREFS_DEFAULTS.repeatErrorLimit,
            APP_PREFS_DEFAULTS.repeatErrorLimitMin,
            APP_PREFS_DEFAULTS.repeatErrorLimitMax
        ),
        modelMaxRetries: clampInt(
            app.modelMaxRetries,
            APP_PREFS_DEFAULTS.modelMaxRetries,
            APP_PREFS_DEFAULTS.modelMaxRetriesMin,
            APP_PREFS_DEFAULTS.modelMaxRetriesMax
        ),
        promptCaching: typeof app.promptCaching === 'boolean' ? app.promptCaching : APP_PREFS_DEFAULTS.promptCaching,
        maxConsecutiveWakes: clampInt(
            app.maxConsecutiveWakes,
            APP_PREFS_DEFAULTS.maxConsecutiveWakes,
            APP_PREFS_DEFAULTS.maxConsecutiveWakesMin,
            APP_PREFS_DEFAULTS.maxConsecutiveWakesMax
        ),
        goalMaxRounds: clampInt(
            app.goalMaxRounds,
            APP_PREFS_DEFAULTS.goalMaxRounds,
            APP_PREFS_DEFAULTS.goalMaxRoundsMin,
            APP_PREFS_DEFAULTS.goalMaxRoundsMax
        )
    };
}

/** 读取风格配置原始段；具体校验与内置合并由 modules/persona 负责。 */
export function getPersonaSettings(): PersonaSettings {
    return getSettings().persona ?? {};
}

/** 整体保存风格配置段；调用方负责传入已校验、已归一的自定义列表。 */
export function setPersonaSettings(next: PersonaSettings): PersonaSettings {
    const settings = getSettings();
    cache = { ...settings, persona: next };
    persist(cache);
    return getPersonaSettings();
}

/** 读取 Hooks 设置（总开关缺省关闭；hash 非字符串视为未信任）。 */
export function getHooksSettings(): { enabled: boolean; trustedHash?: string } {
    const h = getSettings().hooks ?? {};
    return {
        enabled: h.enabled === true,
        ...(typeof h.trustedHash === 'string' && h.trustedHash ? { trustedHash: h.trustedHash } : {})
    };
}

/** 浅合并更新 Hooks 设置并落盘。 */
export function updateHooksSettings(patch: HooksSettings): { enabled: boolean; trustedHash?: string } {
    const settings = getSettings();
    cache = { ...settings, hooks: { ...(settings.hooks ?? {}), ...patch } };
    persist(cache);
    return getHooksSettings();
}

/**
 * 更新应用级偏好并落盘。
 * @param patch 待合并的 app 字段
 * @returns 合并后的完整 app 偏好
 */
export function updateAppSettings(patch: AppPrefs): Required<AppPrefs> {
    const settings = getSettings();
    cache = { ...settings, app: { ...(settings.app ?? {}), ...patch } };
    persist(cache);
    return getAppSettings();
}

/** 读取渠道配置段（缺省空对象）。 */
export function getChannelsSettings(): ChannelsSettings {
    return getSettings().channels ?? {};
}

/**
 * 更新渠道配置并落盘（浅合并 telegram/weixin/plugins）。
 * @param patch 待合并的 channels 字段
 */
export function updateChannelsSettings(patch: ChannelsSettings): ChannelsSettings {
    const settings = getSettings();
    const current = settings.channels ?? {};
    const merged: ChannelsSettings = { plugins: patch.plugins ?? current.plugins };
    cache = { ...settings, channels: merged };
    persist(cache);
    return merged;
}

/** SkillHub 配置默认值。 */
export const SKILLHUB_DEFAULTS: Required<SkillhubSettings> = {
    apiBase: 'https://api.skillhub.cn',
    maxResults: 12,
    timeoutMs: 20000
};

/** 读取 SkillHub 配置（含默认值兜底），供市场客户端使用。 */
export function getSkillhubSettings(): Required<SkillhubSettings> {
    const s = getSettings().skillhub ?? {};
    const apiBase = (s.apiBase ?? '').trim() || SKILLHUB_DEFAULTS.apiBase;
    const maxResults =
        Number.isFinite(s.maxResults) && (s.maxResults as number) > 0
            ? (s.maxResults as number)
            : SKILLHUB_DEFAULTS.maxResults;
    const timeoutMs =
        Number.isFinite(s.timeoutMs) && (s.timeoutMs as number) > 0
            ? (s.timeoutMs as number)
            : SKILLHUB_DEFAULTS.timeoutMs;
    return { apiBase, maxResults: Math.min(80, maxResults), timeoutMs };
}

/**
 * 更新 SkillHub 配置并落盘（浅合并）。空串 / 非法值回落默认。
 * @param patch 待合并的 skillhub 字段
 */
export function updateSkillhubSettings(patch: SkillhubSettings): Required<SkillhubSettings> {
    const settings = getSettings();
    const current = settings.skillhub ?? {};
    const merged: SkillhubSettings = {
        apiBase: patch.apiBase !== undefined ? patch.apiBase : current.apiBase,
        maxResults: patch.maxResults !== undefined ? patch.maxResults : current.maxResults,
        timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeoutMs
    };
    cache = { ...settings, skillhub: merged };
    persist(cache);
    return getSkillhubSettings();
}

/** 读取记忆配置（含默认值兜底）。 */
export function getMemorySettings(): Required<MemorySettings> {
    const m = getSettings().memory ?? {};
    return {
        enabled: typeof m.enabled === 'boolean' ? m.enabled : MEMORY_DEFAULTS.enabled,
        autoExtract: typeof m.autoExtract === 'boolean' ? m.autoExtract : MEMORY_DEFAULTS.autoExtract,
        autoDream: typeof m.autoDream === 'boolean' ? m.autoDream : MEMORY_DEFAULTS.autoDream
    };
}

/** 更新记忆配置并落盘（浅合并）。 */
export function updateMemorySettings(patch: MemorySettings): Required<MemorySettings> {
    const settings = getSettings();
    cache = { ...settings, memory: { ...(settings.memory ?? {}), ...patch } };
    persist(cache);
    return getMemorySettings();
}

/** 把任意数值 clamp 到合法区间；非数字回落默认值。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    // 缺省值（未配置）直接回落默认：Number(undefined) 是 NaN 会走同一分支，但 Number(null) 是 0 会被误 clamp
    if (value === undefined || value === null) return fallback;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 归一 host 规则：去空白、小写、去前导点、去重。
 * 只接受 `example.com` / `*.example.com` / IP 形态；带协议或路径的条目直接丢弃，
 * 避免用户把整条 URL 填进来后规则永远匹配不上。
 */
function normalizeHosts(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const host = item.trim().toLowerCase().replace(/^\.+/, '');
        if (!host || host.includes('/') || host.includes('://') || /\s/.test(host)) continue;
        if (!out.includes(host)) out.push(host);
        if (out.length >= WEB_LIMITS.hostsMax) break;
    }
    return out;
}

/** 读取 Web 访问配置（含默认值兜底与区间 clamp）。 */
export function getWebSettings(): Required<WebSettings> {
    const w = getSettings().web ?? {};
    return {
        enabled: typeof w.enabled === 'boolean' ? w.enabled : WEB_DEFAULTS.enabled,
        fetchEnabled: typeof w.fetchEnabled === 'boolean' ? w.fetchEnabled : WEB_DEFAULTS.fetchEnabled,
        allowedHosts: normalizeHosts(w.allowedHosts),
        blockedHosts: normalizeHosts(w.blockedHosts),
        requireApproval: w.requireApproval === 'always' ? 'always' : 'never',
        timeoutMs: clampInt(w.timeoutMs, WEB_DEFAULTS.timeoutMs, WEB_LIMITS.timeoutMsMin, WEB_LIMITS.timeoutMsMax),
        maxBytes: clampInt(w.maxBytes, WEB_DEFAULTS.maxBytes, WEB_LIMITS.maxBytesMin, WEB_LIMITS.maxBytesMax),
        maxChars: clampInt(w.maxChars, WEB_DEFAULTS.maxChars, WEB_LIMITS.maxCharsMin, WEB_LIMITS.maxCharsMax)
    };
}

/** 更新 Web 访问配置并落盘（浅合并 + 归一）。 */
export function updateWebSettings(patch: WebSettings): Required<WebSettings> {
    const settings = getSettings();
    const current = getWebSettings();
    const merged: WebSettings = {
        enabled: patch.enabled ?? current.enabled,
        fetchEnabled: patch.fetchEnabled ?? current.fetchEnabled,
        allowedHosts: patch.allowedHosts !== undefined ? normalizeHosts(patch.allowedHosts) : current.allowedHosts,
        blockedHosts: patch.blockedHosts !== undefined ? normalizeHosts(patch.blockedHosts) : current.blockedHosts,
        requireApproval: patch.requireApproval ?? current.requireApproval,
        timeoutMs: patch.timeoutMs ?? current.timeoutMs,
        maxBytes: patch.maxBytes ?? current.maxBytes,
        maxChars: patch.maxChars ?? current.maxChars
    };
    cache = { ...settings, web: merged };
    persist(cache);
    return getWebSettings();
}

/** 过滤掉敏感键（导入 env 时禁止携带 danger/token/origins 等）。 */
function filterSensitiveEnv(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (SENSITIVE_ENV_KEYS.includes(key)) {
            console.warn(`[Settings] 导入时忽略敏感键：${key}`);
            continue;
        }
        out[key] = value;
    }
    return out;
}

/**
 * 导出配置（用于备份 / 迁移），只含可安全迁移的段：model、env、app、persona、memory、web。
 * - **provider apiKey 与 env 值一律抹成空串**：env 段常放 AK/SK、token（设置页也只下发键名），
 *   导出只保留键名，导入到新环境后需重新填写（或保留目标环境已存值）。
 * - 刻意不导出：hooks（本机信任闸口）、channels（插件允许列表决定动态 import 哪些本地代码）、
 *   skillhub（apiBase 决定技能安装来源）。这几段一旦能经导入改写，等于绕过本机确认。
 */
export function exportSettings(): AppSettings {
    const { providers, activeModel } = getModelSettings();
    const settings = getSettings();
    return {
        model: { providers: providers.map((p) => ({ ...p, apiKey: '' })), activeModel },
        env: Object.fromEntries(Object.keys(settings.env ?? {}).map((key) => [key, ''])),
        app: settings.app ?? {},
        persona: settings.persona ?? {},
        memory: settings.memory ?? {},
        web: settings.web ?? {}
    };
}

/**
 * 导入配置：**在当前配置上合并**，只改写导入文件里出现的段，其余段原样保留。
 * - model：按 name 并入现有 providers；incoming 的 provider 空 apiKey 时保留目标环境同名 provider 已存密钥；
 *   activeModel 以 incoming 为准（缺省保留现有）。
 * - env：过滤敏感键后按键合并；空值（导出抹除的占位）保留本机已存值，本机没有则以空值占位等待填写
 *   （env 注入只在启动时生效，导入后需重启才应用）。
 * - app / memory / web：浅合并；persona：整段替换。
 * - hooks / channels / skillhub：忽略导入内容，保留本机值（原因见 exportSettings）。
 *
 * @param incoming 外部导入的配置
 */
export function importSettings(incoming: AppSettings): void {
    const settings = getSettings();
    const current = getModelSettings();
    const byName = new Map(current.providers.map((p) => [p.name, p]));
    for (const p of incoming.model?.providers ?? []) {
        const existing = byName.get(p.name);
        byName.set(p.name, {
            name: p.name,
            kind: p.kind,
            baseURL: p.baseURL,
            apiKey: p.apiKey ? p.apiKey : (existing?.apiKey ?? ''),
            models: p.models ?? [],
            modelMeta: pruneModelMeta(p.models ?? [], p.modelMeta ?? existing?.modelMeta)
        });
    }
    let env = settings.env ?? {};
    if (incoming.env) {
        env = { ...env };
        for (const [key, value] of Object.entries(filterSensitiveEnv(incoming.env))) {
            env[key] = value ? value : (env[key] ?? '');
        }
    }
    // 修复：此前用只含 model/env/app/persona/hooks 的新对象整体替换 cache，
    // 导入一次就会清空 channels/skillhub/memory/web 段（连「导出再原样导回」都会丢配置）。
    // 改为以当前配置为底逐段覆盖。
    const merged: AppSettings = {
        ...settings,
        model: { providers: [...byName.values()], activeModel: incoming.model?.activeModel ?? current.activeModel },
        env,
        app: { ...(settings.app ?? {}), ...(incoming.app ?? {}) },
        persona: incoming.persona ?? settings.persona,
        memory: { ...(settings.memory ?? {}), ...(incoming.memory ?? {}) },
        web: { ...(settings.web ?? {}), ...(incoming.web ?? {}) }
    };
    cache = merged;
    persist(merged);
}
