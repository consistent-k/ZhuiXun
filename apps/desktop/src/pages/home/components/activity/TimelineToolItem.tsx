import { memo, useContext, useMemo } from 'react';

import { useChatActions, usePendingApprovalIds } from '../chat-context';
import { ToolLabelContext } from '../tool-label-context';
import { ToolApprovalCard } from '../ToolApprovalCard';

import type { ToolItem } from './model';
import { resolvePresentation } from './registry';
import { ToolCardShell } from './ToolCardShell';

/**
 * 单个工具节点的渲染入口。
 *
 * 审批相关 part 仍走 ToolApprovalCard（保留审批轨迹）；其余走统一的 ToolCardShell。
 * 放在这一层是为了让时间线单卡与分组卡片共用同一套分流逻辑。
 */
export const TimelineToolItem = memo(function TimelineToolItem({ item }: { item: ToolItem }) {
    const labels = useContext(ToolLabelContext);
    const actions = useChatActions();
    const pendingApprovalIds = usePendingApprovalIds();
    const presentation = useMemo(() => resolvePresentation(item, labels), [item, labels]);
    const part = item.part;

    if ('approval' in part && part.approval && !part.approval.isAutomatic) {
        const approval = part.approval;
        if (part.state === 'approval-requested') {
            return (
                <ToolApprovalCard
                    toolName={item.toolName}
                    input={'input' in part ? part.input : undefined}
                    approvalId={approval.id}
                    status="pending"
                    onApprove={actions.approveTool}
                    onDeny={actions.denyTool}
                    isAutomatic={approval.isAutomatic}
                    requestReason={approval.requestReason}
                    actionable={pendingApprovalIds.has(approval.id)}
                />
            );
        }
        if (part.state === 'approval-responded') {
            return (
                <ToolApprovalCard
                    toolName={item.toolName}
                    input={'input' in part ? part.input : undefined}
                    approvalId={approval.id}
                    status={approval.approved ? 'approved' : 'denied'}
                    onApprove={() => {}}
                    onDeny={() => {}}
                    isAutomatic={approval.isAutomatic}
                    requestReason={approval.requestReason}
                />
            );
        }
        if (part.state === 'output-denied') {
            return (
                <ToolApprovalCard
                    toolName={item.toolName}
                    input={'input' in part ? part.input : undefined}
                    approvalId={approval.id}
                    status="denied"
                    onApprove={() => {}}
                    onDeny={() => {}}
                    isAutomatic={approval.isAutomatic}
                    requestReason={approval.requestReason}
                    denialReason={approval.reason}
                />
            );
        }
    }

    return <ToolCardShell item={item} presentation={presentation} />;
});

export default TimelineToolItem;
