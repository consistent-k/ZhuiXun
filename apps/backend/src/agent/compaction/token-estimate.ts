/**
 * 轻量 token 估算：后端无 tokenizer，这里按字符做 CJK 感知的粗估，仅供「压缩边界规划 / 判阈兜底」。
 * 真正权威的触发信号是上一轮模型返回的 usage（最后一步的 input + output），见 compactor。
 *
 * 同一套估算必须同时服务两种消息形态，避免跨轮/轮内两套口径漂移：
 * - UIMessage：`parts` 数组（text / file / tool-<name>）；
 * - ModelMessage：`content` 字符串或 parts 数组（text / reasoning / tool-call / tool-result / image / file）。
 *
 * 估算偏保守（工具入参/产出按其 JSON 体积计入），宁可早触发压缩也不漏触发导致超限。
 */

/** 每条消息的固定结构性开销（role/分隔符等）的粗略 token 计。 */
const PER_MESSAGE_OVERHEAD = 4;
/** 单个附件（图片/PDF，归一化后为内联字节）的粗略 token 计。 */
const PER_FILE_TOKENS = 1200;
/** 单个工具调用/结果 part 的固定结构性开销（名称、id、分隔符等）。 */
const PER_TOOL_TOKENS = 200;

/** CJK 及日文假名区间：这些字符按约 1 token/字计，其余按 4 字符/token。 */
const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ]/g;

/** 估算一段纯文本的 token 数（CJK 约 1/字，其余约 1/4 字符）。 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    const cjk = text.match(CJK_RE)?.length ?? 0;
    const other = text.length - cjk;
    return Math.ceil(cjk + other / 4);
}

/**
 * 可估算的消息形状：UIMessage 有 `parts`，ModelMessage 有 `content`。
 * 用 unknown 承接，避免把 AI SDK 的两套完整类型耦合进来。
 */
export interface TokenEstimableMessage {
    parts?: unknown;
    content?: unknown;
}

interface LoosePart {
    type?: string;
    text?: string;
    input?: unknown;
    output?: unknown;
}

/** 估算单条消息的 token 数（正文 + 工具入参/产出 + 附件/工具 part 的结构性开销）。 */
export function estimateMessageTokens(message: TokenEstimableMessage): number {
    return PER_MESSAGE_OVERHEAD + estimateContentTokens(message.parts ?? message.content);
}

/** 估算一组消息的 token 数之和。 */
export function estimateMessagesTokens(messages: readonly TokenEstimableMessage[]): number {
    return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function estimateContentTokens(content: unknown): number {
    if (typeof content === 'string') return estimateTokens(content);
    if (!Array.isArray(content)) return 0;

    let tokens = 0;
    for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue;
        const part = raw as LoosePart;
        if (part.type === 'text' || part.type === 'reasoning') {
            tokens += estimateTokens(part.text ?? '');
            continue;
        }
        if (part.type === 'file' || part.type === 'image' || part.type === 'reasoning-file') {
            tokens += PER_FILE_TOKENS;
            continue;
        }
        if (part.type === 'tool-call' || part.type === 'tool-result') {
            tokens += PER_TOOL_TOKENS + estimateTokens(safeJson(part.input)) + estimateTokens(safeJson(part.output));
            continue;
        }
        // UIMessage 的工具 part 形如 `tool-Bash`，入参与产出都在 part 上
        if (part.type === 'dynamic-tool' || (typeof part.type === 'string' && part.type.startsWith('tool-'))) {
            tokens += PER_TOOL_TOKENS + estimateTokens(safeJson(part.input)) + estimateTokens(safeJson(part.output));
        }
    }
    return tokens;
}

/** 把入参/产出序列化为估算文本；循环引用或不可序列化时降级为空对象，绝不打断压缩。 */
function safeJson(value: unknown): string {
    if (value === undefined || value === null) return '';
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return '';
    }
}
