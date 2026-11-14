/** 大数字按「万」缩写展示（与 SkillHub 一致）：>=1万 显示 X.X 万，否则原样。 */
export function formatCount(n: number): string {
    if (!Number.isFinite(n)) return '0';
    if (n >= 10000) {
        const w = n / 10000;
        return `${w >= 100 ? Math.round(w) : w.toFixed(1)} 万`;
    }
    return String(n);
}
