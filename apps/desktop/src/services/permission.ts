import type {
    PermissionData,
    PermissionRuleSet,
    PolicyEvaluateResult,
    PolicyRulesView,
    RememberResult,
    RememberScope
} from '@/types/permission';
import request, { type BaseResponse } from '@/utils/request';

/** 获取命令审批权限（总开关 + 永久规则列表） */
export function fetchPermissionsApi(): Promise<BaseResponse<PermissionData>> {
    return request.get('/api/permissions');
}

/** 记住一条命令（Bash）或写入目录（Write）：永久落盘或本次会话 */
export function addPermissionApi(params: {
    tool?: 'Bash' | 'Write';
    command?: string;
    filePath?: string;
    scope: RememberScope;
    sessionId?: string;
}): Promise<BaseResponse<RememberResult>> {
    // hideError：记忆失败不应打扰用户（本次批准已独立生效），交由调用方按 rule 结果轻提示
    return request.post('/api/permissions', { data: { tool: 'Bash', ...params }, hideError: true });
}

/** 删除一条永久规则 */
export function deletePermissionApi(id: string): Promise<BaseResponse<{ id: string }>> {
    return request.delete(`/api/permissions/${id}`);
}

/** 切换自动放行总开关（开关是独立子资源，用 PUT 幂等置位） */
export function setAutoApprovalApi(enabled: boolean): Promise<BaseResponse<PermissionData>> {
    return request.put('/api/permissions/auto-approval', { data: { enabled } });
}

/** 获取声明式权限规则：团队基线（只读）+ 用户规则 + 被跳过的非法规则 */
export function fetchPolicyRulesApi(): Promise<BaseResponse<PolicyRulesView>> {
    return request.get('/api/permissions/rules');
}

/** 整段覆盖写用户规则（后端逐条校验，任一非法返回 400） */
export function updatePolicyRulesApi(rules: PermissionRuleSet): Promise<BaseResponse<PolicyRulesView>> {
    return request.put('/api/permissions/rules', { data: rules });
}

/** 规则格式校验 + 按当前策略试算一次工具调用（只判定、不执行） */
export function evaluatePolicyApi(params: {
    rule?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    cwd?: string;
    mcp?: boolean;
}): Promise<BaseResponse<PolicyEvaluateResult>> {
    return request.post('/api/permissions/rules/evaluate', { data: params });
}
