import { FileOutlined } from '@ant-design/icons';

import { readOutputRecord, readString, type ToolItem } from '../../model';
import useStyles from '../styles';

export function GrepBody({ item }: { item: ToolItem }) {
    const { styles, cx } = useStyles();
    const output = readOutputRecord(item);
    const text = readString(output, ['output']);
    const truncated = output.truncated === true;
    return (
        <div className={cx('tool-presenter', styles.toString())}>
            <pre className="tool-presenter-pre">{text || '（无匹配）'}</pre>
            {truncated && <div className="tool-presenter-note">结果已截断，仅展示前若干条</div>}
        </div>
    );
}

export function GlobBody({ item }: { item: ToolItem }) {
    const { styles, cx } = useStyles();
    const output = readOutputRecord(item);
    const files = Array.isArray(output.files) ? output.files.filter((f): f is string => typeof f === 'string') : [];
    if (files.length === 0) return <div className="tool-presenter-empty">没有匹配的文件</div>;
    return (
        <div className={cx('tool-presenter', styles.toString())}>
            <ul className="tool-presenter-list">
                {files.map((file) => (
                    <li key={`glob-file-${file}`} className="tool-presenter-list-item">
                        <FileOutlined className="tool-presenter-list-icon" />
                        <span className="tool-presenter-list-name" title={file}>
                            {file}
                        </span>
                    </li>
                ))}
            </ul>
            {output.truncated === true && <div className="tool-presenter-note">结果已截断，仅展示前若干个文件</div>}
        </div>
    );
}
