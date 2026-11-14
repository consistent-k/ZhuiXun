import { CodeOutlined, CopyOutlined, EyeOutlined } from '@ant-design/icons';
import { CodeHighlighter, Mermaid } from '@ant-design/x';
import type { ComponentProps } from '@ant-design/x-markdown';
import { App, Button, Flex } from 'antd';
import { isValidElement, useMemo, useState, type ReactNode } from 'react';

import useStyles from './styles';

/** 把 code 子节点还原成纯文本：块级代码通常已是 string，这里容错数组 / 元素（实体已由解析器解码） */
function extractText(node: ReactNode): string {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractText).join('');
    if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
    return '';
}

/** 语言优先取 XMarkdown 注入的 lang，退回 className 里的 language-xxx / lang-xxx */
function resolveLang(props: ComponentProps): string {
    if (props.lang) return props.lang.toLowerCase();
    const cls = typeof props.className === 'string' ? props.className : '';
    return (cls.match(/language-([^\s]+)/)?.[1] ?? cls.match(/lang-([^\s]+)/)?.[1] ?? '').toLowerCase();
}

/** 是否完整 SVG：语言 svg/xml/html，且文本是闭合的 <svg>…</svg>（流式未闭合时先按普通代码走） */
function isCompleteSvg(lang: string, text: string): boolean {
    if (!['svg', 'xml', 'html'].includes(lang)) return false;
    const t = text.trim();
    return /^<svg[\s>]/i.test(t) && /<\/svg>\s*$/i.test(t);
}

/**
 * 覆盖 XMarkdown 的 `code` 组件：
 * - 行内 code 保持原生 <code>；
 * - 完整 SVG 出预览 + 源码切换；
 * - 其余块级代码走官方 `CodeHighlighter`（自带语言标签 + 复制 + Prism 高亮）。
 * 配合 `CodePre` 去掉外层默认 <pre>，由本组件完全接管块级代码的呈现。
 */
export function CodeBlock(props: ComponentProps) {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const { block, children, className } = props;
    const lang = resolveLang(props);
    const text = useMemo(() => extractText(children), [children]);
    const [showSource, setShowSource] = useState(false);

    // 行内 code：保持原生 <code>，不套高亮块
    if (!block) {
        return <code className={className}>{children}</code>;
    }

    // Mermaid 流程图/时序图等：交给官方 Mermaid 组件渲染成图形（自带「图形/源码」切换与缩放）。
    // 组件内部用 mermaid.parse({ suppressErrors: true }) 判断语法，流式中语法未闭合时静默保留上一帧、
    // 不抛错也不渲染半张图，待代码完整到达再出图——因此无需像 SVG 那样显式判断「是否完整」。
    if (lang === 'mermaid' && text.trim()) {
        return (
            <div className={cx('mermaid-code-block', styles.toString())}>
                <Mermaid>{text}</Mermaid>
            </div>
        );
    }

    if (isCompleteSvg(lang, text)) {
        const svg = text.trim();
        // 经 <img> 加载 SVG：浏览器以图片模式解析，内部脚本与外链资源不执行，天然隔离 XSS
        const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
        const copy = () =>
            navigator.clipboard
                .writeText(svg)
                .then(() => message.success('已复制 SVG 源码'))
                .catch(() => message.error('复制失败，请手动选择'));

        return (
            <div className={cx('svg-code-block', styles.toString())}>
                <Flex className="svg-code-block-toolbar" align="center" justify="space-between">
                    <span className="svg-code-block-badge">SVG</span>
                    <Flex gap={4}>
                        <Button
                            type="text"
                            size="small"
                            icon={showSource ? <EyeOutlined /> : <CodeOutlined />}
                            onClick={() => setShowSource((v) => !v)}
                        >
                            {showSource ? '预览' : '源码'}
                        </Button>
                        <Button type="text" size="small" icon={<CopyOutlined />} onClick={copy}>
                            复制
                        </Button>
                    </Flex>
                </Flex>
                {showSource ? (
                    <CodeHighlighter lang="xml" header={false} className="svg-code-block-source">
                        {svg}
                    </CodeHighlighter>
                ) : (
                    <div className="svg-code-block-preview">
                        <img src={dataUri} alt="SVG 预览" />
                    </div>
                )}
            </div>
        );
    }

    return <CodeHighlighter lang={lang}>{text}</CodeHighlighter>;
}

/** 去掉块级代码默认的外层 <pre>：CodeHighlighter / SVG 预览自带容器，避免双层边框与非法嵌套 */
export function CodePre({ children }: ComponentProps) {
    return <>{children}</>;
}
