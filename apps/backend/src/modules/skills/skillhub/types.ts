/**
 * SkillHub 技能广场相关类型。
 * 跨 HTTP 的 DTO 统一定义在 @zhuixun/shared，这里转发以保持 `@/modules/skills/skillhub/types` 引用路径不变。
 */
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
