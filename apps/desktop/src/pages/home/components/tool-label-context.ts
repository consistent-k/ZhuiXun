import { createContext } from 'react';

import type { ToolLabelInfo } from '@/types/tool';

/** 工具元信息（契约类型见 @zhuixun/shared 的 ToolLabelItem）：由 /api/tools/labels 返回，用于把工具名映射为中文说明 */
export type { ToolLabelInfo };

export const ToolLabelContext = createContext<Record<string, ToolLabelInfo>>({});
