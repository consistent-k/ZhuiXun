import { CodeHighlighter } from '@ant-design/x';
import { useMemo } from 'react';

import useStyles from './styles';

/** 详情区单文件预览的最大行数：超出只展示前 N 行，避免大文件一次性进 DOM */
const MAX_PREVIEW_LINES = 200;

interface CodePreviewProps {
    text: string;
    lang: string;
}

/** 只读文件内容预览：等宽、限高滚动、首屏截断。 */
export function CodePreview({ text, lang }: CodePreviewProps) {
    const { styles, cx } = useStyles();
    const preview = useMemo(() => {
        const lines = text.split('\n');
        const truncated = lines.length > MAX_PREVIEW_LINES;
        return {
            shown: truncated ? lines.slice(0, MAX_PREVIEW_LINES).join('\n') : text,
            total: lines.length,
            truncated
        };
    }, [text]);

    if (!text) return <div className="tool-presenter-empty">（空内容）</div>;

    return (
        <div className={cx('tool-presenter', styles.toString())}>
            <div className="tool-presenter-code">
                <CodeHighlighter lang={lang} header={false}>
                    {preview.shown}
                </CodeHighlighter>
            </div>
            {preview.truncated && (
                <div className="tool-presenter-note">
                    仅显示前 {MAX_PREVIEW_LINES} 行（共 {preview.total} 行）
                </div>
            )}
        </div>
    );
}
