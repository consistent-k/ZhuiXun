/**
 * 识别「provider 上下文超限」类错误。
 *
 * 各 provider 的文案不统一（OpenAI `context_length_exceeded`、Anthropic `prompt is too long`、
 * 兼容网关的中文提示等），这里只做保守的文案匹配，避免把限流/鉴权等无关错误误判成超窗而重试。
 * 用途：反应式压缩（provider 报超窗后压缩并重试一次）。
 */
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
    /context[ _-]?length/i,
    /context[ _-]?window/i,
    /maximum context/i,
    /too many tokens/i,
    /token limit/i,
    /prompt is too long/i,
    /input is too long/i,
    /reduce (?:the )?(?:length|size)/i,
    /exceed(?:s|ed)?[^.]{0,40}(?:context|token)/i,
    /超出[^。]{0,20}(?:上下文|token)/i,
    /上下文[^。]{0,20}(?:超|过长|上限)/i
];

export function isContextOverflowError(error: unknown): boolean {
    if (error === undefined || error === null) return false;

    const segments: string[] = [];
    if (typeof error === 'string') segments.push(error);
    if (error instanceof Error) segments.push(error.message);
    const detail = error as { responseBody?: unknown; data?: unknown; cause?: unknown };
    if (typeof detail.responseBody === 'string') segments.push(detail.responseBody);
    if (typeof detail.data === 'string') segments.push(detail.data);
    if (detail.cause !== undefined) segments.push(String(detail.cause));

    const text = segments.join(' ');
    return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}
