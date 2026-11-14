import type { SkillMetadata, SkillRegistry } from '@/modules/skills';

export type SkillLookupRegistry = Pick<SkillRegistry, 'getMetadataById' | 'listMetadata'>;

/**
 * 归一化技能名：只把大小写与 `_` / `-` 视为等价。
 * 依据：轻量模型常把技能 id 里的连字符写成下划线（如 `multi-search_engine`），
 * 精确匹配失败会让 SDK 直接抛 NoSuchToolError 或 load_skill 报「不存在」；除此之外不做编辑距离等模糊猜测。
 * AI SDK cookbook（Add Skills to Your Agent）的 loadSkill 同样按不区分大小写查找。
 */
export function normalizeSkillName(name: string): string {
    return name.toLowerCase().replace(/_/g, '-');
}

/**
 * 按名称查找技能元数据，供技能误调用修复与 load_skill 共用同一套容错。
 *
 * - 精确命中优先，**含停用技能**：调用方据此区分「已停用」与「不存在」，自行决定是否拒绝；
 * - 否则只在**已启用**技能里按归一化名查找，且必须唯一命中，多个候选时不猜。
 */
export function findSkillMetadata(registry: SkillLookupRegistry, name: string): SkillMetadata | undefined {
    const exact = registry.getMetadataById(name);
    if (exact) return exact;
    const key = normalizeSkillName(name);
    const candidates = registry.listMetadata().filter((m) => !m.disabled && normalizeSkillName(m.id) === key);
    return candidates.length === 1 ? candidates[0] : undefined;
}
