import type { ComponentType, ReactNode } from 'react';

import type { ToolItem } from './model';

/** 单个工具的展示描述：摘要行 + 可选的懒加载详情。 */
export interface ToolPresentation {
    icon: ReactNode;
    /** 类别词，如「读取文件」「执行命令」 */
    kindLabel: string;
    /** 摘要行主文本：文件名 / 命令 / pattern */
    primary: ReactNode;
    /** 摘要行次文本：路径、退出码、匹配数等 */
    secondary?: ReactNode;
    /** 来源标签：内置 / 技能工具 / MCP */
    sourceLabel?: string;
    /** 详情组件；不提供则摘要行不可展开 */
    Body?: ComponentType<{ item: ToolItem }>;
    /** 默认展开策略；默认 never */
    autoOpen?: 'never' | 'running' | 'attention';
}

export type ToolPresenter = (item: ToolItem) => ToolPresentation;
