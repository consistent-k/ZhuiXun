/**
 * 上下文压缩事件的跨 HTTP 契约：后端写入 assistant 消息 metadata.compaction，
 * 前端据此渲染「上下文已自动压缩」分隔条。
 *
 * 只收录两端必须一字不差的字段；检查点、摘要等后端落盘结构不在此列。
 */
export interface CompactionMarker {
    /** 本次折叠进摘要的消息条数。 */
    summarizedCount: number;
    /** 保留区（原样喂给模型的近期消息）条数。 */
    keptCount: number;
    /** 压缩前的估算/已知 token 数。 */
    tokensBefore: number;
    /** 压缩后喂给模型输入的估算 token 数。 */
    tokensAfter: number;
}

/**
 * 消息 metadata 中与压缩相关的字段：
 * - `compaction`：自动压缩，挂在压缩后生成的新回复上，分隔条渲染在该消息**之前**；
 * - `manualCompaction`：用户 `/compact` 手动压缩，挂在压缩时最后一条 assistant 消息上，分隔条渲染在其**之后**。
 * 分开两个键，避免手动压缩覆盖同一消息上的自动压缩标记。
 */
export interface CompactionMetadata {
    compaction?: CompactionMarker;
    manualCompaction?: CompactionMarker;
}
