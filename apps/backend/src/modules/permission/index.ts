/** permission 模块公开契约：命令/目录授权记忆、声明式策略与审批决策。 */
export type {
    BashRule,
    PermissionData,
    PermissionRuleSet,
    PolicyDecision,
    PolicyRulesView,
    RememberResult,
    WriteRule
} from '@zhuixun/shared';
export type { RememberInput } from './store';
export { createPermissionStore, getPermissionStore, isWriteDenylisted } from './store';
export type { ApprovalContext, ApprovalDecision, IPermissionBroker } from './broker';
export { createDenyPermissionBroker, createPermissionBroker, rememberPermission } from './broker';
export { BUILTIN_BASELINE } from './baseline';
export type { PolicyContext } from './rules';
export { normalizeRuleSet, parsePermissionRule, toolPath } from './rules';
export { getPolicyEngine, loadBaseline, PolicyEngine, recordApprovalDecision, recordPermissionAudit } from './policy';

export { inspectProjectEdit } from './project-edit-review';
