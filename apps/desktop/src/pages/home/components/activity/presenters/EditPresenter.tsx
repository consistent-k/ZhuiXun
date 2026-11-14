import { EditOutlined } from '@ant-design/icons';

import { diffStats } from '../diff';
import { basename } from '../format';
import { readInput, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { EditBody } from './bodies/EditBody';

export function editPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const path = readString(input, ['file_path']);
    const oldText = readString(input, ['old_string']);
    const newText = readString(input, ['new_string']);
    const replaceAll = input.replace_all === true;
    const stats = diffStats(oldText, newText);
    const change = `+${stats.additions} / -${stats.deletions}`;
    return {
        icon: <EditOutlined />,
        kindLabel: replaceAll ? '编辑文件（全部替换）' : '编辑文件',
        primary: path ? basename(path) : '编辑文件',
        secondary: path ? `${change} · ${path}` : change,
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: EditBody
    };
}
