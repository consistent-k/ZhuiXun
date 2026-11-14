/**
 * conversations 模块公开契约。
 *
 * 模块外只允许从这里 import；`store.ts` / `checkpoint-store.ts` 是模块私有实现。
 */
export type {
    ApprovalTurn,
    CompactionCheckpoint,
    ConversationExport,
    ConversationHistoryEvent,
    ConversationMeta,
    ConversationOrigin,
    ConversationUpsert,
    IConversationService,
    SavedConversation,
    StoredMessage,
    TurnMeta
} from './store';
export { createConversationStore, deriveTitleFromMessages, getConversationStore, isValidConversationId } from './store';
export type { CheckpointRecorder, RewindResult } from './checkpoint-store';
export { createCheckpointStore, getCheckpointStore } from './checkpoint-store';
export { generateConversationTitle } from './title-generator';
export { QuestionValidationError } from '@/agent/tools/question-validation';
