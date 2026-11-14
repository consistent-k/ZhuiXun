import { StreamingMarkdown } from '../../../StreamingMarkdown';
import { readOutputRecord, readString, type ToolItem } from '../../model';
import useStyles from '../styles';

export function TaskBody({ item }: { item: ToolItem }) {
    const { styles, cx } = useStyles();
    const output = readOutputRecord(item);
    const result = readString(output, ['result']);
    const error = readString(output, ['error']);
    if (error) {
        return (
            <div className={cx('tool-presenter', styles.toString())}>
                <div className="tool-presenter-error">{error}</div>
            </div>
        );
    }
    if (!result) return <div className="tool-presenter-empty">（子任务没有返回内容）</div>;
    return (
        <div className={cx('tool-presenter', styles.toString())}>
            <div className="tool-presenter-markdown">
                <StreamingMarkdown text={result} />
            </div>
        </div>
    );
}
