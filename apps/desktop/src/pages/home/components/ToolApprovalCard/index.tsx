import { memo } from 'react';

import { ApprovalCardBody, type ApproveRemember } from '../approval/ApprovalCardBody';
import { locateApproval } from '../approval/locate';

export type { ApproveRemember };

export interface ToolApprovalCardProps {
    /** 工具名称 */
    toolName: string;
    /** 工具输入参数 */
    input?: unknown;
    /** 审批 ID */
    approvalId: string;
    /** 审批状态：pending / approved / denied */
    status: 'pending' | 'approved' | 'denied';
    /** 兼容旧调用点；内联卡已改为只读，动作统一在 ApprovalDock */
    onApprove?: (approvalId: string, remember?: ApproveRemember) => void;
    /** 兼容旧调用点；内联卡已改为只读，动作统一在 ApprovalDock */
    onDeny?: (approvalId: string) => void;
    /** 是否自动批准 */
    isAutomatic?: boolean;
    /** 后端审批管线给出的原因 */
    requestReason?: string;
    /** 拒绝原因（output-denied 时由 part.approval.reason 传入） */
    denialReason?: string;
    /** 是否属于当前轮仍可处理的审批；历史轮次只展示轨迹 */
    actionable?: boolean;
}

/**
 * 内联审批卡：保留时间线上下文与完整详情，但不再提供批准/拒绝按钮。
 *
 * 两个操作面（内联 + dock）容易状态不一致，成熟实现也都只保留一个操作面；
 * 这里统一为「内联只读 + 去确认」，动作在输入框上方的 ApprovalDock 完成。
 */
export const ToolApprovalCard = memo(function ToolApprovalCard({
    toolName,
    input,
    approvalId,
    status,
    isAutomatic,
    requestReason,
    denialReason,
    actionable = true
}: ToolApprovalCardProps) {
    return (
        <ApprovalCardBody
            toolName={toolName}
            input={input}
            approvalId={approvalId}
            status={status}
            isAutomatic={isAutomatic}
            requestReason={requestReason}
            denialReason={denialReason}
            actionable={actionable}
            actions="none"
            onLocate={() => locateApproval(approvalId)}
        />
    );
});

export default ToolApprovalCard;
