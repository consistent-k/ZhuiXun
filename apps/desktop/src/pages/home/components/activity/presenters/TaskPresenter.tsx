import { RobotOutlined } from '@ant-design/icons';

import { truncateSingleLine } from '../format';
import { readInput, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { TaskBody } from './bodies/TaskBody';

export function taskPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const description = readString(input, ['description']);
    return {
        icon: <RobotOutlined />,
        kindLabel: '子任务',
        primary: description ? truncateSingleLine(description, 90) : '子任务',
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: TaskBody
    };
}
