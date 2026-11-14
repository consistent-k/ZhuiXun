/** SkillHub 技能广场前端类型：契约 DTO 复用 @zhuixun/shared，仅 SkillhubConfig 为前端本地视图。 */
export type {
    MarketInstallResult,
    MarketSearchResult,
    MarketSkillCard,
    MarketSkillDetail,
    MarketVersion,
    SkillHubSecurity,
    SkillHubSecurityReport,
    SkillHubSecurityStatus
} from '@zhuixun/shared';

export interface SkillhubConfig {
    apiBase: string;
    maxResults: number;
    timeoutMs: number;
}
