import iconv from 'iconv-lite';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { describe, expect, it, vi } from 'vitest';

import { extractPage, truncateMiddle, type ExtractOptions } from '@/platform/web/extract';

const htmlOptions: ExtractOptions = { mime: 'text/html', maxChars: 10_000 };

function extract(text: string, options: Partial<ExtractOptions> = {}) {
    return extractPage(Buffer.from(text), { ...htmlOptions, ...options });
}

describe('Web response decoding and text extraction', () => {
    it('decodes UTF-8 by default and falls back from an unknown charset', () => {
        for (const charset of [undefined, 'not-an-encoding']) {
            expect(extract('中文 café 🩺', { mime: 'text/plain', charset })).toEqual({ content: '中文 café 🩺' });
        }
    });

    it.each(['gbk', 'utf16le', 'windows-1252'])('uses a supported response charset %s', (charset) => {
        const text = charset === 'windows-1252' ? 'café €' : '操作指南';
        expect(extractPage(iconv.encode(text, charset), { ...htmlOptions, mime: 'text/plain', charset })).toEqual({
            content: text
        });
    });

    it('falls back to Buffer UTF-8 decoding when the decoder throws', () => {
        const decode = vi.spyOn(iconv, 'decode').mockImplementationOnce(() => {
            throw new Error('decoder failed');
        });
        try {
            expect(extract('保留正文', { mime: 'text/plain', charset: 'utf8' })).toEqual({ content: '保留正文' });
        } finally {
            decode.mockRestore();
        }
    });

    it.each(['text/plain', 'text/markdown', 'TEXT/MARKDOWN'])(
        'normalizes whitespace in %s without HTML conversion',
        (mime) => {
            expect(extract(' ﻿# 标题\r\n\r\n\r\n正文​‌‍ \t\r下一行\r\n ', { mime })).toEqual({
                content: '# 标题\n\n正文\n下一行'
            });
            expect(extract('<b>保留标签</b>', { mime }).content).toBe('<b>保留标签</b>');
        }
    );

    it('pretty-prints JSON while preserving nested values and Unicode', () => {
        const value = { title: '操作', items: [1, true, null], nested: { text: 'a\nb' } };
        expect(extract(JSON.stringify(value), { mime: 'APPLICATION/JSON' })).toEqual({
            content: JSON.stringify(value, null, 2)
        });
    });

    it.each(['null', '42', '"正文"', '[]'])('accepts JSON primitive or array %s', (text) => {
        expect(extract(text, { mime: 'application/json' }).content).toBe(JSON.stringify(JSON.parse(text), null, 2));
    });

    it('returns normalized raw text for malformed JSON', () => {
        expect(extract(' \r\n{broken: true} \t\r\n\r\n\r\nend​ ', { mime: 'application/json' })).toEqual({
            content: '{broken: true}\n\nend'
        });
    });

    it.each(['text/plain', 'text/markdown', 'application/json', 'text/html'])(
        'handles an empty body for %s',
        (mime) => {
            expect(extract('', { mime }).content).toBe('');
        }
    );
});

describe('HTML titles, containers and Markdown conversion', () => {
    it('prefers OpenGraph title and decodes named and decimal entities', () => {
        const result = extract(
            `<head><meta property='og:title' content='  A&nbsp;&amp;&lt;&gt;&quot;&#39;&#20013;  '><title>fallback</title></head><body><p>正文</p></body>`
        );
        expect(result).toEqual({ title: 'A &<>"\'中', content: '正文' });
    });

    it('normalizes multiline title whitespace and supports case-insensitive tags', () => {
        expect(extract('<TITLE class="page">  操作\n  指南 &AMP; &#128196; </TITLE><body>正文</body>')).toEqual({
            title: '操作 指南 & 📄',
            content: '正文'
        });
    });

    it('falls back to title when OpenGraph content is empty', () => {
        expect(extract('<meta property="og:title" content=""><title>Fallback</title><body>正文</body>').title).toBe(
            'Fallback'
        );
    });

    it('returns no title when none is present', () => {
        expect(extract('<body><p>正文</p></body>')).toEqual({ title: undefined, content: '正文' });
    });

    it('keeps Markdown structure, inline links and excludes data images', () => {
        const page = extract(
            '<body><h1>指南</h1><p>正文 <strong>重点</strong> <em>提示</em> <a href="https://example.com">参考</a></p><ul><li>首项</li><li>次项</li></ul><img src="data:image/png;base64,AA==" alt="内嵌图片"></body>'
        );
        expect(page.content).toContain('# 指南');
        expect(page.content).toContain('**重点**');
        expect(page.content).toContain('_提示_');
        expect(page.content).toContain('[参考](https://example.com)');
        expect(page.content).toContain('* 首项');
        expect(page.content).toContain('* 次项');
        expect(page.content).not.toContain('data:image');
    });

    it.each([
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
    ])('removes noisy %s blocks before conversion', (tag) => {
        expect(
            extract(`<body><${tag.toUpperCase()} class="noise">机密噪声</${tag.toUpperCase()}><p>正文</p></body>`)
                .content
        ).toBe('正文');
    });

    it('strips comments, self-closing and bare noise tags without dropping following text', () => {
        expect(extract('<body><!--机密注释--><script src="x" /><nav><p>正文</p></body>').content).toBe('正文');
    });

    it('selects the longest article/main candidate rather than surrounding body content', () => {
        expect(
            extract(
                '<body><p>非正文</p><article>短文</article><main class="content"><p>这是最长的一段正文</p></main><article>另一段</article></body>'
            ).content
        ).toBe('这是最长的一段正文');
    });

    it('keeps the first candidate when candidate lengths tie', () => {
        expect(extract('<article>甲乙</article><main>丙丁</main>').content).toBe('甲乙');
    });

    it('falls back to the body when no main container exists', () => {
        expect(extract('<head><title>页面标题</title></head><body>实际正文</body>').content).toBe('实际正文');
    });

    it.each(['', 'application/xhtml+xml'])('treats MIME %j and HTML fragments as HTML', (mime) => {
        expect(extract('<h2>片段</h2><p>正文</p>', { mime }).content).toBe('## 片段\n\n正文');
    });

    it('uses entity-decoded plain text when the Markdown dependency fails', () => {
        const translate = vi.spyOn(NodeHtmlMarkdown, 'translate').mockImplementationOnce(() => {
            throw new Error('HTML parser failed');
        });
        try {
            expect(extract('<body><p> A&nbsp;&amp; &#20013; </p>\n<b> B </b></body>').content).toBe('A & 中 B');
        } finally {
            translate.mockRestore();
        }
    });

    it('also falls back when Markdown conversion produces no text', () => {
        // translate 也重载支持 FileCollection；本用例只调用 string → string 签名。
        const translate = vi.spyOn(NodeHtmlMarkdown as { translate: (html: string) => string }, 'translate');
        translate.mockReturnValueOnce('');
        try {
            expect(extract('<p>仍有正文 &lt; &#39;</p>').content).toBe("仍有正文 < '");
        } finally {
            translate.mockRestore();
        }
    });
});

describe('middle truncation', () => {
    it.each([
        ['', 0],
        ['abc', 3],
        ['abc', 4]
    ])('leaves %j unchanged at limit %s', (text, maxChars) => {
        expect(truncateMiddle(text, maxChars)).toEqual({ content: text, truncated: false });
    });

    it('retains 70% head and 30% tail with an accurate omission marker', () => {
        expect(truncateMiddle('0123456789ABCDEFGHIJ', 10)).toEqual({
            content: '0123456\n\n…（内容过长，已省略中间约 10 字符）…\n\nHIJ',
            truncated: true
        });
    });

    it('rounds the head down and gives the remaining budget to the tail', () => {
        expect(truncateMiddle('0123456789', 3)).toEqual({
            content: '01\n\n…（内容过长，已省略中间约 7 字符）…\n\n9',
            truncated: true
        });
    });

    it.each([
        [1, '9', 9],
        [0, '', 10]
    ])('handles a small nonnegative character budget %s', (limit, tail, omitted) => {
        expect(truncateMiddle('0123456789', limit)).toEqual({
            content: `\n\n…（内容过长，已省略中间约 ${omitted} 字符）…\n\n${tail}`,
            truncated: true
        });
    });
});
