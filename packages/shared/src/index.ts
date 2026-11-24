/**
 * @zhuixun/shared —— 前后端共享的 HTTP 契约类型（纯类型，零运行时、零依赖）。
 * 仅收「跨 HTTP、两端本就该一字不差」的 DTO；后端内部 domain / 落盘类型不在此列。
 */
export type { ApiResponse } from './response';
export type {
    AskUserQuestionOption,
    AskUserQuestion,
    AskUserQuestionInput,
    AskUserQuestionAnswer,
    AskUserQuestionOutput
} from './interaction';
export type { CompactionMarker, CompactionMetadata } from './compaction';
export type {
    CommandDetail,
    CommandExpandResult,
    CommandPartData,
    CommandSummary,
    CommandUpsertInput
} from './command';
export type { Task, TaskStatus } from './task';
export type {
    AutomationCreateRequest,
    AutomationDispatchStatus,
    AutomationEvent,
    AutomationKind,
    AutomationLifecycleStatus,
    AutomationRunOutcome,
    AutomationRunView,
    AutomationSchedule,
    AutomationUpdateRequest,
    AutomationView
} from './automation';
export type { JobCreateRequest, JobStatus, JobView } from './job';
export type { GoalArmRequest, GoalStatus, GoalView } from './goal';
export type { DeliveryDeferReason, SessionEvent, SessionEventSource, SessionTurnOutcome } from './session';
export type { ToolLabelItem } from './tool';
export type { RetryNotice, TurnStopReason } from './turn';
export type { HookAuditEntry, HookEventName, HooksStatus, HooksView } from './hooks';
export type {
    MemoryManifestItem,
    MemoryOverview,
    MemoryProjectSummary,
    MemoryRecord,
    MemoryScope,
    MemoryType
} from './memory';
export type {
    ApprovalMode,
    BaselineSource,
    BashRule,
    PermissionData,
    PermissionRuleSet,
    PolicyDecision,
    PolicyDecisionKind,
    PolicyEvaluateResult,
    PolicyRulesView,
    PolicySource,
    RememberResult,
    RememberScope,
    WriteRule
} from './permission';
export type {
    MarketInstallResult,
    MarketSearchResult,
    MarketSkillCard,
    MarketSkillDetail,
    MarketVersion,
    SkillHubSecurity,
    SkillHubSecurityReport,
    SkillHubSecurityStatus
} from './skillhub';
export type { ModelMeta, ProviderKind, ProviderView } from './model';
export type { PersonaConfigView, PersonaCreateInput, PersonaKind, PersonaUpdateInput, PersonaView } from './persona';
export type { WebApprovalPolicy, WebSettingsPatch, WebSettingsView } from './web';
export type { WorkspaceFileReference, WorkspaceSummary, WorkspaceFileView } from './workspace';
