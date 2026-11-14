import { FileTextOutlined } from '@ant-design/icons';

import { basename } from '../format';
import { readInput, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { ReadBody } from './bodies/ReadBody';

export function readPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const path = readString(input, ['path']);
    return {
        icon: <FileTextOutlined />,
        kindLabel: '读取文件',
        primary: path ? basename(path) : '读取文件',
        secondary: path || undefined,
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: ReadBody
    };
}
