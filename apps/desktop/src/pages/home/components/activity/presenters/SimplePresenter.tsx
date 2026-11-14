import { BulbOutlined, ThunderboltOutlined } from '@ant-design/icons';

import { truncateSingleLine } from '../format';
import { readInput, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { JsonBody } from './JsonBody';

function memoryLabel(item: ToolItem, name: string): string {
    switch (item.toolName) {
        case 'read_memory':
            return name ? `读取记忆 ${name}` : '读取记忆';
        case 'write_memory':
            return name ? `保存记忆 ${name}` : '保存记忆';
        case 'delete_memory':
            return name ? `删除记忆 ${name}` : '删除记忆';
        default:
            return item.toolName;
    }
}

function skillLabel(item: ToolItem, name: string): string {
    switch (item.toolName) {
        case 'load_skill':
            return name ? `加载技能 ${name}` : '加载技能';
        case 'list_skills':
            return '查看技能列表';
        case 'create_skill':
            return name ? `新建技能 ${name}` : '新建技能';
        case 'update_skill':
            return name ? `更新技能 ${name}` : '更新技能';
        default:
            return item.toolName;
    }
}

export function memoryPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const name = readString(input, ['name']);
    return {
        icon: <BulbOutlined />,
        kindLabel: '记忆',
        primary: truncateSingleLine(memoryLabel(item, name), 90),
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: JsonBody
    };
}

export function skillPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const name = readString(input, ['skillId', 'name']);
    return {
        icon: <ThunderboltOutlined />,
        kindLabel: '技能',
        primary: truncateSingleLine(skillLabel(item, name), 90),
        sourceLabel: '内置',
        autoOpen: 'never',
        Body: JsonBody
    };
}
