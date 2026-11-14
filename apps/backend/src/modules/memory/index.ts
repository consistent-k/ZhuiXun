/** memory 模块公开契约：多文件长期记忆（全局层 + 项目层）。 */
export type { MemoryManifestItem, MemoryOverview, MemoryRecord, MemoryScope, MemoryType } from './types';
export { MEMORY_TYPES, isMemoryScope, isMemoryType } from './types';
export type { WriteMemoryInput, WriteMemoryResult } from './store';
export { getMemoryStore, MemoryStore } from './store';
export type { RecallLayer } from './recall';
export { recallMemories } from './recall';
export { buildMemorySection } from './inject';
export type { TranscriptMessage } from './maintenance';
export { createMemoryMaintenance, runMemoryDream, runMemoryMaintenance } from './maintenance';
export type { ApplyResult, MemoryDeleteOp, MemoryOp, MemoryWriteOp } from './ops';
export { applyMemoryOps, parseMemoryOps } from './ops';
export { readIndex } from './index-file';
export {
    globalMemoryRoot,
    projectsMemoryParent,
    projectMemoryRoot,
    resolveMemoryRoot,
    sanitizeMemoryName
} from './scope';
export { memoryItemId, selectRelevantMemories, type TaggedManifestItem } from './selector';
