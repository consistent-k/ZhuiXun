export const LOCATE_APPROVAL_EVENT = 'zhuixun:locate-approval';
export const LOCATE_QUESTION_EVENT = 'zhuixun:locate-question';

/** 内联审批卡的「去确认」：把底部 dock 切到对应项并聚焦 */
export function locateApproval(approvalId: string): void {
    window.dispatchEvent(new CustomEvent(LOCATE_APPROVAL_EVENT, { detail: { approvalId } }));
}

/** 内联提问卡的「去回答」：滚动到对应卡片 */
export function locateQuestion(toolCallId: string): void {
    window.dispatchEvent(new CustomEvent(LOCATE_QUESTION_EVENT, { detail: { toolCallId } }));
}
