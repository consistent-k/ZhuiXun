/** SkillHub 技能广场契约 DTO（搜索 / 详情 / 安装）。 */

/** 安全扫描状态（SkillHub securityReports 的 status，映射到前端徽章）。 */
export type SkillHubSecurityStatus = 'benign' | 'scanning' | 'suspicious' | 'malicious' | 'unknown';

/** 单个扫描器报告（keen / sanbu）。 */
export interface SkillHubSecurityReport {
    status: SkillHubSecurityStatus;
    statusText?: string;
    reportUrl?: string;
}

/** 聚合后的安全信息，供卡片展示。 */
export interface SkillHubSecurity {
    /** 多个扫描器里最严重的状态（malicious > suspicious > scanning > benign）。 */
    worst: SkillHubSecurityStatus;
    reports: Record<string, SkillHubSecurityReport>;
}

/** 技能卡片 DTO（搜索 / 详情共用）。 */
export interface MarketSkillCard {
    slug: string;
    name: string;
    description: string;
    category: string;
    /** 分类的中文展示名（如 dev-programming → 开发编程）；无映射时回退原 key。 */
    categoryLabel: string;
    version: string;
    downloads: number;
    stars: number;
    installs: number;
    /** 是否需要配置 API Key（上游 labels.requires_api_key）。 */
    requiresApiKey: boolean;
    iconUrl?: string;
    owner?: string;
    /** 规范名 `@owner/slug`，详情页展示。 */
    canonicalName?: string;
    /** 概述正文（markdown，仅详情接口返回，可能为空）。 */
    overview?: string;
    /** 上游来源：clawhub（镜像）/ community（SkillHub 原生）/ enterprise 等，用于透出 provenance。 */
    source?: string;
    /** 认证发布者。 */
    verified?: boolean;
    publisherName?: string;
    /** 安全扫描信息（可能缺省）。 */
    security?: SkillHubSecurity;
    /** 该技能是否已安装到本地（后端比对本地技能目录得出）。 */
    installed: boolean;
    /** SkillHub 技能主页。 */
    pageUrl?: string;
}

/** 搜索结果（offset 翻页 + 已安装标注）。 */
export interface MarketSearchResult {
    query: string;
    category?: string;
    items: MarketSkillCard[];
    total: number;
    offset: number;
    hasMore: boolean;
}

/** 版本历史条目。 */
export interface MarketVersion {
    version: string;
    changelog?: string;
    createdAt?: number;
    security?: SkillHubSecurity;
}

/** 技能详情（卡片 + 版本历史）。 */
export interface MarketSkillDetail {
    card: MarketSkillCard;
    versions: MarketVersion[];
}

/** 安装结果。 */
export interface MarketInstallResult {
    /** 落盘后的本地技能 id。 */
    id: string;
    slug: string;
    version: string;
    /** 来源规范名 `@namespace/slug`（有则回传，供前端按 canonicalName 标注已安装）。 */
    canonicalName?: string;
}
