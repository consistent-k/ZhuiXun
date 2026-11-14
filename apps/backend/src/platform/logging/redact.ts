/**
 * 敏感信息脱敏。
 *
 * 背景：后端持有 MODEL_API_KEY 等密钥，日志一旦把请求体 / error 对象整个打印出来就会泄漏
 * （chat.ts 已注释过这一风险）。这里在写日志前对 fields 递归脱敏：
 * - 按 key 命中黑名单 → 值替换为 ***REDACTED***
 * - 对已知密钥的**实际值**做兜底掩码（防止密钥出现在 message / url / stack 里）
 * - 限制递归深度、数组长度、字符串长度，并防循环引用
 */

const REDACTED = '***REDACTED***';
const MAX_DEPTH = 8;
const MAX_ARRAY = 100;
const MAX_STRING = 10_000;

/** 命中即整值脱敏的 key（大小写不敏感，子串匹配）。 */
const SENSITIVE_KEY =
    /(api[_-]?key|access[_-]?token|refresh[_-]?token|^authorization$|^auth$|secret|password|passwd|^pwd$|^token$|cookie|bearer|client[_-]?secret|x-api-key)/i;

let secretsCache: string[] | null = null;

/** 从环境变量里收集"疑似密钥的实际值"，用于在自由文本中兜底掩码。 */
function secrets(): string[] {
    if (secretsCache) return secretsCache;
    const out: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
        if (value && value.length >= 8 && SENSITIVE_KEY.test(key)) out.push(value);
    }
    secretsCache = out;
    return out;
}

function maskSecrets(text: string): string {
    let out = text;
    for (const secret of secrets()) {
        if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
}

function truncate(text: string): string {
    return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…(${text.length} 字符)` : text;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') return maskSecrets(truncate(value));
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;

    if (value instanceof Error) {
        return {
            name: value.name,
            message: maskSecrets(value.message),
            stack: value.stack ? maskSecrets(value.stack) : undefined
        };
    }

    if (depth >= MAX_DEPTH) return '[Depth limit]';

    if (Array.isArray(value)) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        return value.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1, seen));
    }

    if (typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            out[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(val, depth + 1, seen);
        }
        return out;
    }

    return String(value);
}

/** 对日志附加字段递归脱敏，返回可安全序列化的副本。 */
export function redact(input: unknown): unknown {
    return walk(input, 0, new WeakSet());
}
