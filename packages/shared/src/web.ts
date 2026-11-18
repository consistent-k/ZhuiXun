/**
 * Web 访问配置的前后端契约（HTTP DTO）。
 *
 * 本期只覆盖 WebFetch；搜索相关字段在 WebSearch 阶段再新增。
 */
export type WebApprovalPolicy = 'never' | 'always';

/** GET/PUT /api/settings/web 的返回体（真源为后端 settings.json 的 web 段）。 */
export interface WebSettingsView {
    /** Web 能力总开关。 */
    enabled: boolean;
    /** WebFetch 开关（总开关开启时仍可单独关闭抓取）。 */
    fetchEnabled: boolean;
    /** 用户显式配置的 HTTP(S) 代理地址，空串表示直连。 */
    proxyUrl: string;
    /** 允许访问的域名；非空时即为白名单（支持 `*.example.com`）。 */
    allowedHosts: string[];
    /** 禁止访问的域名，优先于白名单。 */
    blockedHosts: string[];
    /** 是否每次调用都要求用户在界面上确认。 */
    requireApproval: WebApprovalPolicy;
    /** 单次抓取的总超时（毫秒）。 */
    timeoutMs: number;
    /** 单次响应体字节上限（解压后）。 */
    maxBytes: number;
    /** 返回给模型的正文最大字符数。 */
    maxChars: number;
}

/** PUT /api/settings/web 的请求体：所有字段可选，按浅合并落盘。 */
export type WebSettingsPatch = Partial<WebSettingsView>;
