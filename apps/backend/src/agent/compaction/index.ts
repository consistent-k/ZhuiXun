/** 上下文自动压缩模块入口（模块外只经此引用）。 */
export {
    forceCompactContext,
    maybeCompactContext,
    reactiveCompactContext,
    type CompactContextParams,
    type CompactionOutcome,
    type ForceCompactParams
} from './compactor';
export {
    createOverflowHandler,
    withPreOutputRecovery,
    withReactiveCompaction,
    type PreOutputRecoveryHandler,
    type ReactiveStreamPart,
    type ReactiveStreamRetry,
    type RecoveryResult
} from './reactive-stream';
export { createStepCompactor } from './step-compactor';
export type { CompactionMarker } from './types';
