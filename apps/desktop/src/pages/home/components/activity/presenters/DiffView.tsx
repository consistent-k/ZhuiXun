import { useMemo } from 'react';

import { diffLines } from '../diff';

import useStyles from './styles';

interface DiffViewProps {
    oldText: string;
    newText: string;
}

/** Edit 的行级 diff：新增/删除行用颜色与 +/-  gutter 区分。 */
export function DiffView({ oldText, newText }: DiffViewProps) {
    const { styles, cx } = useStyles();
    const result = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

    if (result.lines.length === 0) return <div className="tool-presenter-empty">（无内容变化）</div>;

    return (
        <div className={cx('tool-presenter', styles.toString())}>
            <div className="tool-presenter-diff">
                {result.lines.map((line, index) => (
                    <div key={`diff-line-${index}`} className={cx('tool-presenter-diff-line', `is-${line.type}`)}>
                        <span className="tool-presenter-diff-gutter">
                            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                        </span>
                        <span>{line.text || ' '}</span>
                    </div>
                ))}
            </div>
            {result.truncated && <div className="tool-presenter-note">文本过长，仅比较前 200 行</div>}
        </div>
    );
}
