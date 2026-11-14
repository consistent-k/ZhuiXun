import { ApiOutlined } from '@ant-design/icons';

import { parseMcpName, truncateSingleLine } from '../format';
import { readInput, readString, type ToolItem } from '../model';
import type { ToolPresentation } from '../presentation';

import { JsonBody } from './JsonBody';

/** 未知工具 / MCP 的兜底卡片：摘要 + 参数/结果 JSON。 */
export function genericPresentation(item: ToolItem): ToolPresentation {
    const input = readInput(item);
    const mcp = parseMcpName(item.toolName);
    const detail = readString(input, ['command', 'query', 'path', 'url', 'name', 'description', 'prompt']);
    const label = mcp ? `${mcp.server} · ${mcp.tool}` : item.toolName;
    return {
        icon: <ApiOutlined />,
        kindLabel: label,
        primary: detail ? truncateSingleLine(detail, 90) : mcp ? mcp.tool : item.toolName,
        sourceLabel: mcp ? 'MCP' : undefined,
        autoOpen: 'never',
        Body: JsonBody
    };
}
