/**
 * 环境变量读取原语：本文件是 src 内**唯一**直接触碰 `process.env` 的地方
 * （`bootstrap-settings` 的引导注入除外）。其余模块一律经由 `config/*` 的访问器读取，
 * 把每个配置项的名称、默认值、解析规则收在一处。
 *
 * 所有访问器都「调用时求值」——不在模块顶层缓存 `process.env`，避免早于
 * `index.ts` 首行的 `bootstrap-settings` 注入、读到尚未注入的值（引导顺序问题）。
 */

/** 原始值（不加工）；未设返回 undefined，用于需要区分「未设 / 空串」的场景。 */
export function optional(key: string): string | undefined {
    return process.env[key];
}

/** 字符串：未设或纯空白时回落默认值。 */
export function str(key: string, fallback = ''): string {
    const v = process.env[key];
    return v !== undefined && v.trim() !== '' ? v : fallback;
}

/**
 * 数字：未设 / 非有限数回落默认值。`positive` 为真时 `<= 0` 也回落
 * （对齐历史上的 `Number(x) || N` 写法：0 视为「用默认」）。
 */
export function num(key: string, fallback: number, opts?: { positive?: boolean }): number {
    const v = process.env[key];
    if (v === undefined || v.trim() === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (opts?.positive && n <= 0) return fallback;
    return n;
}

/** 布尔：1/true/yes/on 为真，0/false/no/off 为假，其余（含未设）回落默认值。 */
export function bool(key: string, fallback: boolean): boolean {
    const v = process.env[key]?.trim().toLowerCase();
    if (v === undefined || v === '') return fallback;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return fallback;
}

/** 分隔串 → 数组（trim + 过滤空项）。默认逗号分隔。 */
export function list(key: string, separator = ','): string[] {
    return (process.env[key] || '')
        .split(separator)
        .map((s) => s.trim())
        .filter(Boolean);
}
