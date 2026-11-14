import { FileAddOutlined } from '@ant-design/icons';

import { basename, lineCount } from '../format';
import { readInput, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { WriteBody } from './bodies/WriteBody';

export function writePresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const path = readString(input, ['path']);
    const content = readString(input, ['content']);
    const lines = lineCount(content);
    return {
        icon: <FileAddOutlined />,
        kindLabel: '写入文件',
        primary: path ? basename(path) : '写入文件',
        secondary: `${lines} 行${path ? ` · ${path}` : ''}`,
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: WriteBody
    };
}
