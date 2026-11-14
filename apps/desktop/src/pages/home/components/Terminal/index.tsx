import {
    CheckOutlined,
    CodeOutlined,
    CopyOutlined,
    DeleteOutlined,
    DownOutlined,
    LoadingOutlined
} from '@ant-design/icons';
import { CodeHighlighter } from '@ant-design/x';
import { Button, Tooltip } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import useStyles from './styles';

interface TerminalProps {
    /** trace 行标题，形如 "Ran pnpm build"；Bash 场景传命令本身 */
    title?: string;
    stdout?: string;
    stderr?: string;
    /** 是否默认展开（默认收起，保持会话流紧凑） */
    defaultOpen?: boolean;
    /** 流式执行中：trace 行显示运行态，并在有输出后自动展开、自动吸底 */
    running?: boolean;
    /** 提供时在 trigger 旁渲染「清空」按钮 */
    onClear?: () => void;
}

/**
 * 终端输出：对标 shadcn/ui 的 Trace + CodeBlock（见 ai-elements/terminal），用本仓 antd 技术栈实现。
 * 一条可折叠的 trace 行（折叠箭头 + 终端图标 + 标题 + 运行态）+ 旁置的复制/清空按钮（按钮不能嵌在 trigger 内），
 * 展开后用官方 CodeHighlighter 渲染输出（换行 + 限高滚动）。
 */
export function Terminal({
    title = '终端',
    stdout,
    stderr,
    defaultOpen = false,
    running = false,
    onClear
}: TerminalProps) {
    const { styles, cx } = useStyles();
    // null = 用户未手动切换：此时展开态由 running+有输出 派生（运行中一旦有输出就自动展开）
    const [manualOpen, setManualOpen] = useState<boolean | null>(defaultOpen ? true : null);
    const [copied, setCopied] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<number>(0);

    const output = `${stdout ?? ''}${stdout && stderr ? '\n' : ''}${stderr ?? ''}`;
    const hasOutput = output.length > 0;
    const open = manualOpen ?? (running && hasOutput);

    // 流式时自动吸底
    useEffect(() => {
        if (open && running && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }, [output, running, open]);

    useEffect(() => () => window.clearTimeout(timerRef.current), []);

    const onCopy = useCallback(() => {
        navigator.clipboard
            ?.writeText(output)
            .then(() => {
                setCopied(true);
                window.clearTimeout(timerRef.current);
                timerRef.current = window.setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
    }, [output]);

    // 标题（命令）+ 运行态：trigger 可点/静态两种形态共用
    const headline = (
        <>
            <CodeOutlined className="term-icon" />
            <span className="term-title" title={title}>
                {title}
            </span>
            {running && (
                <span className="term-status">
                    <LoadingOutlined /> 运行中
                </span>
            )}
        </>
    );

    return (
        <div className={cx('term', open && 'term--open', styles.toString())}>
            <div className="term-row">
                {hasOutput ? (
                    <button type="button" className="term-trigger" onClick={() => setManualOpen(!open)}>
                        <DownOutlined className="term-chevron" />
                        {headline}
                    </button>
                ) : (
                    <div className="term-trigger term-trigger--static">{headline}</div>
                )}
                <div className="term-actions">
                    {hasOutput && (
                        <Tooltip title={copied ? '已复制' : '复制'}>
                            <Button
                                type="text"
                                size="small"
                                icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                                onClick={onCopy}
                            />
                        </Tooltip>
                    )}
                    {onClear && (
                        <Tooltip title="清空">
                            <Button type="text" size="small" icon={<DeleteOutlined />} onClick={onClear} />
                        </Tooltip>
                    )}
                </div>
            </div>
            {open && hasOutput && (
                <div className="term-content" ref={bodyRef}>
                    <CodeHighlighter lang="text" header={false} className="term-code">
                        {output}
                    </CodeHighlighter>
                </div>
            )}
        </div>
    );
}
