import { Lexer, type Token } from 'marked';
import { useMemo } from 'react';

/** 一个可独立渲染的 Markdown 顶层块 */
export interface MarkdownBlock {
    /** 块在源文本中的起始偏移：既作 React key，也让块越过边界时不会重挂载 */
    key: number;
    /** 该块的原始 Markdown 文本 */
    raw: string;
}

/** marked 中不产生视觉内容、不参与分块的 token 类型 */
const SKIP_TOKEN_TYPES = new Set(['space', 'def']);

/**
 * 按顶层 token 切分 Markdown，块在源文本中的起始偏移作 key。
 *
 * 用 marked 的 Lexer 而不是正则/空行切分：列表、表格、引用、代码块都是单个 token，
 * 不会在块内部被切断，切出来的每块都能独立交给 XMarkdown 渲染。
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
    const tokens = Lexer.lex(text) as Token[];
    const blocks: MarkdownBlock[] = [];
    let offset = 0;
    for (const token of tokens) {
        const raw = token.raw ?? '';
        if (raw && !SKIP_TOKEN_TYPES.has(token.type)) blocks.push({ key: offset, raw });
        offset += raw.length;
    }
    return blocks;
}

/**
 * 把流式中的 Markdown 文本切成顶层块，供每块独立渲染与 memo。
 *
 * 为什么要分块：XMarkdown 对传入的整段文本做 marked → DOMPurify → html-react-parser，成本随文本长度
 * 线性增长；流式中每 50ms 提交一次，一条回复写到几千字时单次提交就会超过一帧。分块后每块一个
 * `XMarkdown`，块的 `raw` 不变则 memo 命中、不再重新解析，实际每次只重算末尾一块。
 *
 * 这里每次都对全文做一遍 lex：marked 的 lexer 是纯扫描，实测远低于渲染成本（毫秒级），
 * 换来的是无缓存、无渲染副作用；真正的大头（DOM 解析与高亮）由块的 memo 挡住。
 */
export function useMarkdownBlocks(text: string): MarkdownBlock[] {
    return useMemo(() => splitMarkdownBlocks(text), [text]);
}
