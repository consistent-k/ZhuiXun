/** chat 模块公开契约：一轮对话的用例编排与可恢复流。 */
export type { ChatTurnHandle, ChatTurnInput, ChatTurnStream } from './service';
export { ChatTurnError, runChatTurn } from './service';
export { CompactError, compactConversation, type CompactConversationResult } from './compact';
export { cleanupStaleStreamFiles, createResumableStreamStore, getResumableStreamStore } from './stream-store';
export {
    canStoreAttachment,
    isAllowedAttachment,
    MAX_FILE_BYTES,
    MAX_IMAGE_BYTES,
    readAttachment,
    saveAttachment
} from './attachments/store';
export type { TurnPhase, TurnState } from './turn-state';
export { canTransition, createTurnState } from './turn-state';
export { configureBackgroundTurns, startBackgroundTurn } from './background';
export {
    SessionRuntime,
    sessionEvents,
    sessionRuntime,
    subscribeSessionEvents,
    type SessionIdleListener,
    type SessionTurnStarter
} from './session-runtime';

export { desktopApprovalGrants } from './approval-grants';
