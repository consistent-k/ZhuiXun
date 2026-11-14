/** 大于等于此阈值的 token 数用 `k` 缩写展示，否则用千分位整数（如 9,999 / 12.3k）。 */
const ABBREVIATE_THRESHOLD = 10000;

/**
 * 格式化 token 数用于展示。
 *
 * 小于阈值走千分位整数（`1234` → `1,234`），大于等于阈值走一位小数 `k` 缩写（`12345` → `12.3k`）。
 * 入参 undefined / 非有限值 / 负值一律安全兜底为 `'0'`，绝不产出 `NaN` 或负值文案。
 *
 * @param count token 数量
 * @returns 用于展示的字符串
 */
export function formatTokenCount(count?: number): string {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return '0';
    if (count >= ABBREVIATE_THRESHOLD) return `${(count / 1000).toFixed(1)}k`;
    return new Intl.NumberFormat('en-US').format(Math.round(count));
}

/**
 * 格式化百分比用于展示（入参为 0-100 的百分数，而非 0-1 比率）。
 *
 * 四舍五入到整数并追加 `%`；入参 undefined / 非有限值 / 负值兜底为 `'0%'`，超过 100 收敛到 `100%`，不产出 `NaN`。
 *
 * @param percent 0-100 的百分数
 * @returns 形如 `75%` 的字符串
 */
export function formatPercent(percent?: number): string {
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent <= 0) return '0%';
    return `${Math.min(100, Math.round(percent))}%`;
}
