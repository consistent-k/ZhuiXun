/**
 * 记忆数据模型（对齐 ZCode 的类型化多文件记忆）。
 *
 * 作用域双层：global=用户个人长期画像（全局单库、所有会话共享）；
 * project=按项目隔离的专属事实（自学相关性召回）。
 *
 * 跨 HTTP 的 DTO 定义在 @zhuixun/shared，这里只保留运行时校验辅助。
 */
import type { MemoryManifestItem, MemoryOverview, MemoryRecord, MemoryScope, MemoryType } from '@zhuixun/shared';

export type { MemoryManifestItem, MemoryOverview, MemoryRecord, MemoryScope, MemoryType };

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export function isMemoryType(value: unknown): value is MemoryType {
    return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isMemoryScope(value: unknown): value is MemoryScope {
    return value === 'global' || value === 'project';
}
