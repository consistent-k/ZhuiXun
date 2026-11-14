import iconv from 'iconv-lite';
import { NodeHtmlMarkdown } from 'node-html-markdown';

/** 正文抽取结果：title 仅 HTML 页面有；content 已做过空白归一。 */
export interface ExtractedPage {
    title?: string;
    content: string;
}

export interface ExtractOptions {
    mime: string;
    charset?: string;
    maxChars: number;
}

/** 与正文无关、且常含导航/脚本/样式的块，转换前直接剔除。 */
const NOISE_TAGS = [
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'iframe',
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'button'
];

function decodeBody(body: Buffer, charset?: string): string {
    const encoding = charset && iconv.encodingExists(charset) ? charset : 'utf8';
    try {
        return iconv.decode(body, encoding);
    } catch {
        return body.toString('utf8');
    }
}

function stripNoise(html: string): string {
    let out = html.replace(/<!--[\s\S]*?-->/g, ' ');
    for (const tag of NOISE_TAGS) {
        out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
        // 自闭合 / 未闭合形态（如 <script src=... />）
        out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
    }
    return out;
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function extractTitle(html: string): string | undefined {
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (og?.[1]) return decodeHtmlEntities(og[1]).trim();
    const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (title?.[1]) return decodeHtmlEntities(title[1]).replace(/\s+/g, ' ').trim();
    return undefined;
}

/**
 * 选正文容器：优先 `<article>` / `<main>`（取文本最长的一个），否则退回 `<body>`。
 * 不用完整 Readability：多一个 DOM 依赖，收益有限；文档站与博客的 article/main 通常足够。
 */
function pickMainHtml(html: string): string {
    const candidates: string[] = [];
    for (const tag of ['article', 'main']) {
        const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
        let match: RegExpExecArray | null;
        while ((match = re.exec(html)) !== null) {
            candidates.push(match[1]);
        }
    }
    if (candidates.length > 0) {
        return candidates.reduce((longest, current) => (current.length > longest.length ? current : longest));
    }
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    return body ? body[1] : html;
}

function normalizeMarkdown(markdown: string): string {
    return markdown
        .replace(/\r\n?/g, '\n')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function stripTagsAsText(html: string): string {
    return decodeHtmlEntities(
        html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
}

function htmlToMarkdown(html: string): string {
    try {
        return NodeHtmlMarkdown.translate(html, {
            maxConsecutiveNewlines: 2,
            keepDataImages: false,
            useInlineLinks: true
        });
    } catch {
        return stripTagsAsText(html);
    }
}

/**
 * 头 70% + 尾 30% 截断：保留开头（背景/结论）与结尾（总结/结论），
 * 比单纯截头部更不容易丢关键信息。
 */
export function truncateMiddle(text: string, maxChars: number): { content: string; truncated: boolean } {
    if (text.length <= maxChars) return { content: text, truncated: false };
    const headLength = Math.floor(maxChars * 0.7);
    const tailLength = maxChars - headLength;
    const omitted = text.length - maxChars;
    const marker = `\n\n…（内容过长，已省略中间约 ${omitted} 字符）…\n\n`;
    return {
        content: `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`,
        truncated: true
    };
}

/** 把原始响应体转成可读正文（HTML → Markdown；文本 / JSON 直通）。 */
export function extractPage(body: Buffer, options: ExtractOptions): ExtractedPage {
    const text = decodeBody(body, options.charset);
    const mime = options.mime.toLowerCase();

    if (mime === 'application/json') {
        try {
            return { content: JSON.stringify(JSON.parse(text), null, 2) };
        } catch {
            return { content: normalizeMarkdown(text) };
        }
    }

    if (mime === 'text/plain' || mime === 'text/markdown') {
        return { content: normalizeMarkdown(text) };
    }

    // mime 为空时按 HTML 处理：不少站点省略 Content-Type，直接判失败体验太差
    const title = extractTitle(text);
    const cleaned = stripNoise(pickMainHtml(text));
    const markdown = normalizeMarkdown(htmlToMarkdown(cleaned));
    return {
        title,
        content: markdown || stripTagsAsText(cleaned)
    };
}
