import { GlobalOutlined } from '@ant-design/icons';

import { hostOf } from '../format';
import { readInput, readOutputRecord, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { WebFetchBody } from './bodies/WebFetchBody';

export function webFetchPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const output = readOutputRecord(item);
    const url = readString(input, ['url']);
    const title = readString(output, ['title']);
    const ok = output.ok !== false;
    return {
        icon: <GlobalOutlined />,
        kindLabel: ok ? '读取网页' : '网页读取失败',
        primary: url ? hostOf(url) : '读取网页',
        secondary: title || url,
        sourceLabel: '内置',
        autoOpen: ok ? 'never' : 'attention',
        Body: WebFetchBody
    };
}
