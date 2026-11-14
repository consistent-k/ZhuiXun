import { FolderOpenOutlined, SearchOutlined } from '@ant-design/icons';

import { truncateSingleLine } from '../format';
import { readInput, readOutputRecord, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { GlobBody, GrepBody } from './bodies/SearchBodies';

export function grepPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const output = readOutputRecord(item);
    const pattern = readString(input, ['pattern']);
    const text = readString(output, ['output']);
    const matched = output.matched === true;
    const matchedLines = text ? text.split('\n').filter(Boolean).length : 0;
    return {
        icon: <SearchOutlined />,
        kindLabel: '检索内容',
        primary: pattern ? <code>{truncateSingleLine(pattern, 80)}</code> : '检索内容',
        secondary: matched ? `${matchedLines} 条匹配` : '无匹配',
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: GrepBody
    };
}

export function globPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const output = readOutputRecord(item);
    const pattern = readString(input, ['pattern']);
    const count = typeof output.count === 'number' ? output.count : 0;
    return {
        icon: <FolderOpenOutlined />,
        kindLabel: '查找文件',
        primary: pattern ? <code>{truncateSingleLine(pattern, 80)}</code> : '查找文件',
        secondary: `${count} 个文件`,
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: GlobBody
    };
}
