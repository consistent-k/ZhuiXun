import type { GoalView } from '@/types/goal';
import request, { type BaseResponse } from '@/utils/request';

/** 取某会话的自驱状态（无则 null） */
export function fetchGoalApi(sessionId: string): Promise<BaseResponse<GoalView | null>> {
    return request.get('/api/goal', { params: { sessionId } });
}

/** 停止某会话的自驱循环 */
export function disarmGoalApi(sessionId: string): Promise<BaseResponse<GoalView>> {
    return request.post(`/api/goal/${encodeURIComponent(sessionId)}/disarm`);
}
