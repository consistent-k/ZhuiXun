import { UnorderedListOutlined } from '@ant-design/icons';

import { basename } from '../format';
import { readInput, readOutputRecord, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { LsBody } from './bodies/LsBody';

function entryCount(item: ToolItem): number {
    const output = readOutputRecord(item);
    return Array.isArray(output.entries) ? output.entries.length : 0;
}

export function lsPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const output = readOutputRecord(item);
    const path = readString(output, ['path']) || readString(input, ['path']);
    const count = entryCount(item);
    return {
        icon: <UnorderedListOutlined />,
        kindLabel: '列出目录',
        primary: path ? basename(path) : '列出目录',
        secondary: `${count} 项 · ${path}`,
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: LsBody
    };
}
