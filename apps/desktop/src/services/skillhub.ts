import type { MarketInstallResult, MarketSearchResult, MarketSkillDetail, SkillhubConfig } from '@/types/skillhub';
import request, { type BaseResponse } from '@/utils/request';

export interface SkillHubSearchParams {
    q?: string;
    category?: string;
    source?: string;
    sort?: string;
    limit?: number;
    offset?: number;
}

/** 搜索 / 浏览 SkillHub 技能。 */
export function searchSkillHubApi(params: SkillHubSearchParams): Promise<BaseResponse<MarketSearchResult>> {
    return request.get('/api/skillhub/search', { params });
}

/** 技能详情（含版本历史）。canonicalName 用于同 slug 跨 namespace 消歧，建议从卡片透传，否则只能拿到
 *  namespace 默认那个（两个同 slug 技能详情页会一样）。 */
export function fetchSkillHubDetailApi(slug: string, canonicalName?: string): Promise<BaseResponse<MarketSkillDetail>> {
    return request.get(`/api/skillhub/skills/${encodeURIComponent(slug)}`, {
        params: canonicalName ? { canonicalName } : undefined
    });
}

/** 下载并安装一个 SkillHub 技能到本地技能目录。canonicalName（`@namespace/slug`）用于同 slug 跨
 *  namespace 的下载消歧与「已安装」标注；displayName 为市场展示名，落到 metadata.display_name，使「已安装」
 *  列表显示用户在市场看到的名字（如「编程专家.Skill」）而非裸 slug。都建议从卡片透传。 */
export function installSkillHubApi(
    slug: string,
    version?: string,
    canonicalName?: string,
    displayName?: string
): Promise<BaseResponse<MarketInstallResult>> {
    return request.post('/api/skillhub/install', { data: { slug, version, canonicalName, displayName } });
}

/** 读取 SkillHub 配置。 */
export function fetchSkillHubConfigApi(): Promise<BaseResponse<SkillhubConfig>> {
    return request.get('/api/skillhub/config');
}

/** 更新 SkillHub 配置。 */
export function updateSkillHubConfigApi(patch: Partial<SkillhubConfig>): Promise<BaseResponse<SkillhubConfig>> {
    return request.put('/api/skillhub/config', { data: patch });
}
