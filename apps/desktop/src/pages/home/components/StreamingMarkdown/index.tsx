import type { XMarkdownProps } from '@ant-design/x-markdown';
import { XMarkdown } from '@ant-design/x-markdown';
import { memo } from 'react';

import { CodeBlock, CodePre } from '../CodeBlock';
import { parseFileReference } from '../WorkspacePanel/file-reference';
import { FileLink } from '../WorkspacePanel/FileReference';

import useStyles from './styles';
import { useMarkdownBlocks } from './useMarkdownBlocks';
import '@ant-design/x-markdown/themes/light.css';

/**
 * 模块级常量：`XMarkdown` 是 memo 的，但 `components` / `streaming` 一旦在渲染期新建对象就会让它
 * 每次重建 `Parser`/`Renderer` 并整段重解析。这里固定引用，配合下面 `MarkdownBlock` 的 memo 才有效。
 */
const MD_COMPONENTS = { pre: CodePre, code: CodeBlock, a: FileLink };

/** 流式期只给「末尾一块」开：未闭合的表格 / 链接 / 强调先缓存在 XMarkdown 内部，成形后一次落地 */
// 把本地链接编码成安全的相对引用；不关闭 DOMPurify，也不放行任意 URI 协议。
const LINK_MARKDOWN: XMarkdownProps['config'] = {
    renderer: {
        link(token) {
            const reference = parseFileReference(token.href);
            if (reference?.kind !== 'workspace') return false;
            const href = `/__zhuixun_file_reference__?path=${encodeURIComponent(reference.path)}${reference.line ? `&amp;line=${reference.line}` : ''}`;
            return `<a href="${href}">${this.parser.parseInline(token.tokens)}</a>`;
        }
    }
};
const SAFE_FILE_MARKDOWN: XMarkdownProps['config'] = { renderer: { ...LINK_MARKDOWN.renderer, html: () => '' } };

const STREAMING_OPTION: XMarkdownProps['streaming'] = { hasNextChunk: true };

interface MarkdownBlockProps {
    raw: string;
    /** 该块是否仍在增长（只有末尾块为 true） */
    streaming: boolean;
    safeFile?: boolean;
}

/**
 * 单个 Markdown 块。`raw` 不变即命中 memo，不再重新解析、不再重建 DOM——
 * 这是流式期间「只重算末尾一块」的关键。
 */
const MarkdownBlock = memo(function MarkdownBlock({ raw, streaming, safeFile }: MarkdownBlockProps) {
    return (
        <XMarkdown
            className="x-markdown-light"
            content={raw}
            config={safeFile ? SAFE_FILE_MARKDOWN : LINK_MARKDOWN}
            openLinksInNewTab
            components={MD_COMPONENTS}
            streaming={streaming ? STREAMING_OPTION : undefined}
        />
    );
});

interface StreamingMarkdownProps {
    text: string;
    /** 该段文本是否仍在流式增长 */
    streaming?: boolean;
    /** 文件预览不渲染原始 HTML。 */
    safeFile?: boolean;
}

/**
 * 流式 Markdown：按顶层块切分后逐块渲染。
 *
 * 原来整段交给一个 `XMarkdown`，每 50ms 提交都要把整条回复重新 marked → DOMPurify → html-react-parser，
 * 成本随回复长度线性增长（实测单次提交 50–240ms）。分块后已完成的块被 memo 冻结，实际只重算末尾块。
 *
 * 已知取舍：引用式链接（`[text][ref]` + 文末 `[ref]: url`）跨块后不再解析；LLM 输出极少使用。
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({
    text,
    streaming,
    safeFile
}: StreamingMarkdownProps) {
    const { styles, cx } = useStyles();
    const blocks = useMarkdownBlocks(text);

    if (blocks.length === 0) return null;

    return (
        <div className={cx('stream-md', styles.toString())}>
            {blocks.map((block, index) => (
                <MarkdownBlock
                    key={block.key}
                    raw={block.raw}
                    safeFile={safeFile}
                    streaming={Boolean(streaming) && index === blocks.length - 1}
                />
            ))}
        </div>
    );
});

export default StreamingMarkdown;
