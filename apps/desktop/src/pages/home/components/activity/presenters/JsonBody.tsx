import { formatJson } from '../format';
import { readOutput, type ToolItem } from '../model';

import useStyles from './styles';

interface JsonBodyProps {
    item: ToolItem;
}

/** 通用兜底详情：调用参数 + 返回结果，JSON 截断展示。 */
export function JsonBody({ item }: JsonBodyProps) {
    const { styles, cx } = useStyles();
    const input = 'input' in item.part ? item.part.input : undefined;
    const output = readOutput(item);
    const hasInput = input !== undefined && input !== null;
    const hasOutput = output !== undefined && output !== null;

    if (!hasInput && !hasOutput) return <div className="tool-presenter-empty">（暂无参数或结果）</div>;

    return (
        <div className={cx('tool-presenter', styles.toString())}>
            <div className="tool-presenter-json">
                {hasInput && (
                    <section className="tool-presenter-json-section">
                        <h4 className="tool-presenter-json-title">调用参数</h4>
                        <pre className="tool-presenter-pre">{formatJson(input)}</pre>
                    </section>
                )}
                {hasOutput && (
                    <section className="tool-presenter-json-section">
                        <h4 className="tool-presenter-json-title">返回结果</h4>
                        <pre className="tool-presenter-pre">{formatJson(output)}</pre>
                    </section>
                )}
            </div>
        </div>
    );
}
