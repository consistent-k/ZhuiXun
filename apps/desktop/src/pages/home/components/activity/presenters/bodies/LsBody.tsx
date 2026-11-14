import { FileOutlined, FolderOutlined, LinkOutlined } from '@ant-design/icons';

import { readOutputRecord, type ToolItem } from '../../model';
import useStyles from '../styles';

interface LsEntry {
    name: string;
    type: string;
}

function readEntries(item: ToolItem): LsEntry[] {
    const output = readOutputRecord(item);
    const entries = Array.isArray(output.entries) ? output.entries : [];
    return entries
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .map((entry) => ({
            name: typeof entry.name === 'string' ? entry.name : '',
            type: typeof entry.type === 'string' ? entry.type : 'file'
        }))
        .filter((entry) => entry.name.length > 0);
}

export function LsBody({ item }: { item: ToolItem }) {
    const { styles, cx } = useStyles();
    const entries = readEntries(item);
    if (entries.length === 0) return <div className="tool-presenter-empty">目录为空</div>;
    return (
        <div className={cx('tool-presenter', styles.toString())}>
            <ul className="tool-presenter-list">
                {entries.map((entry) => (
                    <li key={`ls-entry-${entry.type}-${entry.name}`} className="tool-presenter-list-item">
                        {entry.type === 'dir' ? (
                            <FolderOutlined className="tool-presenter-list-icon" />
                        ) : entry.type === 'symlink' ? (
                            <LinkOutlined className="tool-presenter-list-icon" />
                        ) : (
                            <FileOutlined className="tool-presenter-list-icon" />
                        )}
                        <span className="tool-presenter-list-name" title={entry.name}>
                            {entry.name}
                            {entry.type === 'dir' ? '/' : ''}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
