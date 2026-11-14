import { CodeOutlined } from '@ant-design/icons';

import { truncateSingleLine } from '../format';
import { readInput, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { BashBody } from './bodies/BashBody';

export function bashPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const command = readString(input, ['command']);
    return {
        icon: <CodeOutlined />,
        kindLabel: item.status === 'running' ? '执行中' : '执行命令',
        primary: command ? <code>{truncateSingleLine(command, 90)}</code> : '执行命令',
        sourceLabel: '内置',
        autoOpen: 'attention',
        Body: BashBody
    };
}
