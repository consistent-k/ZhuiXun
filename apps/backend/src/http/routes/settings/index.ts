import { generateText } from 'ai';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { createModel } from '@/agent/model/provider';
import {
    addProvider,
    deleteProvider,
    exportSettings,
    getAppSettings,
    getModelSettings,
    getProvider,
    getWebSettings,
    importSettings,
    isValidUserEnvKey,
    listEnvKeys,
    listProviders,
    ProviderError,
    removeEnvVar,
    setActiveModel,
    setEnvVar,
    updateAppSettings,
    updateProvider,
    updateWebSettings,
    type AppSettings
} from '@/config/settings-store';
import type { ApiResponse } from '@/config/types';
import { getLogger } from '@/platform/logging/index';
import { fetchReadablePage, WebAccessError } from '@/platform/web';

const settings = new Hono();

function badRequest(c: Context, error: z.ZodError) {
    const message = `请求参数不合法: ${error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
    return c.json({ code: 400, message } satisfies ApiResponse, 400);
}

function serverError(c: Context, message: string, error: unknown) {
    getLogger('Settings').error(message, { err: error });
    return c.json({ code: 500, message: `${message}，请查看后端日志` } satisfies ApiResponse, 500);
}

// ---------- 模型配置（多 provider + 激活选择）----------

const providerKindEnum = z.enum(['openai', 'anthropic', 'google', 'openai-compatible']);
const providerNameRule = z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, '仅支持字母、数字、下划线、连字符');

// apiKey 可选：留空/缺省表示保留后端已存密钥（避免「只改配置却清空 key」）。
// 每模型元信息映射（key=modelName），目前仅 contextWindow；正整数校验避免 NaN/负值/0 落盘。
const modelMetaSchema = z
    .record(z.string(), z.object({ contextWindow: z.number().int().positive().optional() }))
    .optional();
const providerCreateSchema = z.object({
    name: providerNameRule,
    kind: providerKindEnum,
    baseURL: z.string().min(1),
    apiKey: z.string().optional(),
    models: z.array(z.string().min(1)).default([]),
    modelMeta: modelMetaSchema
});
const providerUpdateSchema = z.object({
    name: providerNameRule.optional(),
    kind: providerKindEnum.optional(),
    baseURL: z.string().min(1).optional(),
    apiKey: z.string().optional(),
    models: z.array(z.string().min(1)).optional(),
    modelMeta: modelMetaSchema
});
const activeModelSchema = z.object({ activeModel: z.string().min(1) });

/** 把 ProviderError 映射为 HTTP 响应；非 ProviderError 交给上层 500。 */
function providerErrorResponse(c: Context, error: unknown): Response | null {
    if (!(error instanceof ProviderError)) return null;
    const map: Record<string, { code: number; message: string }> = {
        DUPLICATE_PROVIDER: { code: 409, message: 'provider 名称已存在' },
        PROVIDER_NOT_FOUND: { code: 404, message: 'provider 不存在' },
        INVALID_ACTIVE_MODEL: { code: 400, message: '激活模型无效：provider 不存在或该模型不在其模型列表内' }
    };
    const m = map[error.code];
    return c.json({ code: m.code, message: m.message } satisfies ApiResponse, m.code as 400 | 404 | 409);
}

// 全部 provider（脱敏，无 apiKey）+ 当前激活模型
settings.get('/api/settings/model', (c) => {
    const { activeModel } = getModelSettings();
    return c.json({ code: 0, data: { providers: listProviders(), activeModel } } satisfies ApiResponse);
});

settings.post('/api/settings/providers', async (c) => {
    const parsed = providerCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
        return c.json({
            code: 0,
            data: addProvider({ ...parsed.data, apiKey: parsed.data.apiKey ?? '' })
        } satisfies ApiResponse);
    } catch (error) {
        return providerErrorResponse(c, error) ?? serverError(c, '新增 provider 失败', error);
    }
});

settings.put('/api/settings/providers/:name', async (c) => {
    const parsed = providerUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
        return c.json({ code: 0, data: updateProvider(c.req.param('name'), parsed.data) } satisfies ApiResponse);
    } catch (error) {
        return providerErrorResponse(c, error) ?? serverError(c, '更新 provider 失败', error);
    }
});

settings.delete('/api/settings/providers/:name', (c) => {
    try {
        return c.json({ code: 0, data: { deleted: deleteProvider(c.req.param('name')) } } satisfies ApiResponse);
    } catch (error) {
        return serverError(c, '删除 provider 失败', error);
    }
});

settings.put('/api/settings/model/active', async (c) => {
    const parsed = activeModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
        return c.json({
            code: 0,
            data: { activeModel: setActiveModel(parsed.data.activeModel) }
        } satisfies ApiResponse);
    } catch (error) {
        return providerErrorResponse(c, error) ?? serverError(c, '设置激活模型失败', error);
    }
});

// 连通性测试：用指定 provider 的（或临时传入的）密钥 + 某个模型发一次最小请求。
const providerTestSchema = z.object({ model: z.string().optional(), apiKey: z.string().optional() });
settings.post('/api/settings/providers/:name/test', async (c) => {
    const parsed = providerTestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(c, parsed.error);
    const provider = getProvider(c.req.param('name'));
    if (!provider) return c.json({ code: 404, message: 'provider 不存在' } satisfies ApiResponse, 404);

    const apiKey = parsed.data.apiKey || provider.apiKey;
    const modelName = parsed.data.model || provider.models[0];
    if (!apiKey) return c.json({ code: 0, data: { ok: false, error: '未配置 API Key' } } satisfies ApiResponse);
    if (!modelName) return c.json({ code: 0, data: { ok: false, error: '未配置模型名' } } satisfies ApiResponse);

    try {
        const model = createModel({ kind: provider.kind, baseURL: provider.baseURL, apiKey, modelName });
        await generateText({ model, prompt: 'ping', maxOutputTokens: 1 });
        return c.json({ code: 0, data: { ok: true } } satisfies ApiResponse);
    } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        getLogger('Settings').warn('模型连通性测试失败', { detail });
        return c.json({ code: 0, data: { ok: false, error: detail } } satisfies ApiResponse);
    }
});

// ---------- 应用级偏好 ----------

settings.get('/api/settings/app', (c) => {
    return c.json({ code: 0, data: getAppSettings() } satisfies ApiResponse);
});

const appWriteSchema = z.object({
    defaultAgentMode: z.enum(['routed', 'progressive']).optional(),
    autoCompactEnabled: z.boolean().optional(),
    autoCompactThreshold: z.number().int().min(50).max(95).optional(),
    maxAgentSteps: z.number().int().min(10).max(200).optional(),
    repeatErrorLimit: z.number().int().min(2).max(10).optional(),
    modelMaxRetries: z.number().int().min(0).max(5).optional(),
    promptCaching: z.boolean().optional()
});

settings.put('/api/settings/app', async (c) => {
    const parsed = appWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
        return c.json({ code: 0, data: updateAppSettings(parsed.data) } satisfies ApiResponse);
    } catch (error) {
        getLogger('Settings').error('保存应用设置失败', { err: error });
        return c.json({ code: 500, message: '保存应用设置失败，请查看后端日志' } satisfies ApiResponse, 500);
    }
});

// ---------- 导入 / 导出（apiKey 与 env 值不随导出泄漏；导入过滤敏感 env 键）----------

settings.get('/api/settings/export', (c) => {
    return c.json({ code: 0, data: exportSettings() } satisfies ApiResponse);
});

/** host 规则：域名或 `*.example.com`；拒绝协议 / 路径 / 端口，避免把 URL 当规则存进去。 */
const webHostRule = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^(\*|(\*\.)?[a-z0-9][a-z0-9._-]*)$/i, '仅支持域名或 *.example.com 形式');

const webWriteSchema = z.object({
    enabled: z.boolean().optional(),
    fetchEnabled: z.boolean().optional(),
    allowedHosts: z.array(webHostRule).max(200).optional(),
    blockedHosts: z.array(webHostRule).max(200).optional(),
    requireApproval: z.enum(['never', 'always']).optional(),
    timeoutMs: z.number().int().min(1000).max(60_000).optional(),
    maxBytes: z
        .number()
        .int()
        .min(64 * 1024)
        .max(10 * 1024 * 1024)
        .optional(),
    maxChars: z.number().int().min(1000).max(100_000).optional()
});

const importSchema = z.object({
    model: z
        .object({
            providers: z
                .array(
                    z.object({
                        name: providerNameRule,
                        kind: providerKindEnum,
                        baseURL: z.string().min(1),
                        apiKey: z.string().optional(),
                        models: z.array(z.string()).optional(),
                        modelMeta: modelMetaSchema
                    })
                )
                .optional(),
            activeModel: z.string().optional()
        })
        .optional(),
    env: z.record(z.string(), z.string()).optional(),
    app: z
        .object({
            defaultAgentMode: z.enum(['routed', 'progressive']).optional(),
            autoCompactEnabled: z.boolean().optional(),
            autoCompactThreshold: z.number().int().min(50).max(95).optional(),
            maxAgentSteps: z.number().int().min(10).max(200).optional(),
            repeatErrorLimit: z.number().int().min(2).max(10).optional(),
            modelMaxRetries: z.number().int().min(0).max(5).optional(),
            promptCaching: z.boolean().optional()
        })
        .optional(),
    persona: z
        .object({
            defaultId: z.string().max(80).optional(),
            custom: z
                .array(
                    z.object({
                        id: z.string().min(1).max(80).startsWith('custom_'),
                        name: z.string().max(30),
                        description: z.string().max(100),
                        instruction: z.string().max(2000),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    })
                )
                .max(20)
                .optional()
        })
        .optional(),
    memory: z
        .object({
            enabled: z.boolean().optional(),
            autoExtract: z.boolean().optional(),
            autoDream: z.boolean().optional()
        })
        .optional(),
    web: webWriteSchema.optional()
});

settings.post('/api/settings/import', async (c) => {
    const parsed = importSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
        importSettings(parsed.data as unknown as AppSettings);
        // env 注入只在启动时生效：导入的 env 段需重启后端才应用（model / app 立即生效）
        return c.json({ code: 0, data: { imported: true, envNeedsRestart: !!parsed.data.env } } satisfies ApiResponse);
    } catch (error) {
        getLogger('Settings').error('导入配置失败', { err: error });
        return c.json({ code: 500, message: '导入配置失败，请查看后端日志' } satisfies ApiResponse, 500);
    }
});

// ---------- 环境变量（settings.json env 段，注入 process.env 供技能/脚本/MCP 读取）----------

const envKeyRule = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, '仅支持大写字母、数字、下划线，且以字母开头');
const envSetSchema = z.object({ key: envKeyRule, value: z.string() });

// 只回键名，不下发值（对齐 provider apiKey 的 configured 约定；env 段可能含 token 等敏感值）。
settings.get('/api/settings/env', (c) => {
    return c.json({ code: 0, data: { keys: listEnvKeys() } } satisfies ApiResponse);
});

settings.post('/api/settings/env', async (c) => {
    const parsed = envSetSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    // 二次把关安全敏感键（danger-mode / 鉴权 / CORS），避免经前端打开高危能力。
    if (!isValidUserEnvKey(parsed.data.key)) {
        return c.json(
            { code: 400, message: `环境变量 ${parsed.data.key} 受保护，不可经此设置` } satisfies ApiResponse,
            400
        );
    }
    try {
        setEnvVar(parsed.data.key, parsed.data.value);
        return c.json({ code: 0, data: { configured: true } } satisfies ApiResponse);
    } catch (error) {
        return serverError(c, '设置环境变量失败', error);
    }
});

settings.delete('/api/settings/env/:key', (c) => {
    removeEnvVar(c.req.param('key'));
    return c.json({ code: 0, data: { removed: true } } satisfies ApiResponse);
});

// ---------- Web 访问（settings.json web 段；本期仅 WebFetch；schema 定义在导入导出段之前，供导入复用）----------

// 读取 Web 配置（不含任何密钥；本期没有搜索 key）
settings.get('/api/settings/web', (c) => {
    return c.json({ code: 0, data: getWebSettings() } satisfies ApiResponse);
});

settings.put('/api/settings/web', async (c) => {
    const parsed = webWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
        return c.json({ code: 0, data: updateWebSettings(parsed.data) } satisfies ApiResponse);
    } catch (error) {
        return serverError(c, '保存 Web 访问设置失败', error);
    }
});

const webTestSchema = z.object({ url: z.string().trim().min(1) });

// 连通性测试：走与 WebFetch 完全相同的受控抓取链，但不检查 enabled（便于关闭状态下先验证配置）。
settings.post('/api/settings/web/test', async (c) => {
    const parsed = webTestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);

    const settings = getWebSettings();
    const startedAt = Date.now();
    try {
        const page = await fetchReadablePage(parsed.data.url, {
            allowedHosts: settings.allowedHosts,
            blockedHosts: settings.blockedHosts,
            timeoutMs: settings.timeoutMs,
            maxBytes: settings.maxBytes,
            // 测试只需要确认能读到内容，返回少量正文即可
            maxChars: Math.min(settings.maxChars, 2000)
        });
        const title = page.title ? `${page.title} · ` : '';
        return c.json({
            code: 0,
            data: {
                ok: true,
                detail: `${title}${page.content.length} 字符${page.truncated ? '（已截断）' : ''}`,
                ms: Date.now() - startedAt
            }
        } satisfies ApiResponse);
    } catch (error) {
        const detail =
            error instanceof WebAccessError
                ? `${error.code}: ${error.message}`
                : error instanceof Error
                  ? error.message
                  : String(error);
        getLogger('Settings').warn('Web 连通性测试失败', { url: parsed.data.url, detail });
        return c.json({ code: 0, data: { ok: false, detail, ms: Date.now() - startedAt } } satisfies ApiResponse);
    }
});

export default settings;
