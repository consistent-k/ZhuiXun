/**
 * 上下文自动压缩的运行层类型。
 *
 * 检查点的持久化形态 {@link CompactionCheckpoint} 定义在会话仓储（随会话落盘）；
 * 展示标记是跨 HTTP 契约，统一放在 @zhuixun/shared，这里只转发以保持模块内引用路径不变。
 */
import type { CompactionMarker } from '@zhuixun/shared';

export type { CompactionMarker };
