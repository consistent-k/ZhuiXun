import { StreamingMarkdown } from '../../../StreamingMarkdown';
import { readOutputRecord, readString, type ToolItem } from '../../model';
import useStyles from '../styles';

export function WebFetchBody({ item }: { item: ToolItem }) {
    const { styles, cx } = useStyles();
    const output = readOutputRecord(item);
    if (output.ok === false) {
        const code = readString(output, ['code']);
        const message = readString(output, ['message']);
        return (
            <div className={cx('tool-presenter', styles.toString())}>
                <div className="tool-presenter-error">
                    {code ? `${code}：` : ''}
                    {message || '网页读取失败'}
                </div>
            </div>
        );
    }
    const content = readString(output, ['content']);
    if (!content) return <div className="tool-presenter-empty">（网页没有可读正文）</div>;
    return (
        <div className={cx('tool-presenter', styles.toString())}>
            <div className="tool-presenter-markdown">
                <StreamingMarkdown text={content} />
            </div>
            {output.truncated === true && <div className="tool-presenter-note">正文已截断</div>}
        </div>
    );
}
