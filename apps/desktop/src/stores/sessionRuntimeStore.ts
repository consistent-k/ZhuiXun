import { create } from 'zustand';

import { SUCCESS_CODE } from '@/constant/code';
import { disarmGoalApi, fetchGoalApi } from '@/services';
import type { GoalView } from '@/types/goal';
import type { JobView } from '@/types/job';

interface SessionRuntimeState {
    /** 各会话自驱状态（后端为真源，本地只做镜像） */
    goals: Record<string, GoalView>;
    /** 正在执行的后台任务 id -> 任务视图（用于 keep-awake 与状态展示） */
    runningJobs: Record<string, JobView>;
    /** 最近完成的后台任务（toast 之外可做轻量展示，保留最近一条） */
    lastFinishedJob?: JobView;
}

interface SessionRuntimeActions {
    /** 从 SSE / 接口写入自驱状态 */
    setGoal: (goal: GoalView) => void;
    /** 拉一次某会话自驱状态（打开会话时补历史态） */
    loadGoal: (sessionId: string) => Promise<void>;
    /** 手动停止自驱 */
    disarmGoal: (sessionId: string) => Promise<void>;
    /** 后台任务状态更新：running 进表，终态出表 */
    setJob: (job: JobView) => void;
    /** 清空（测试/退出用） */
    reset: () => void;
}

/** 终态判定与后端 JobStatus 对齐。 */
function isTerminal(status: JobView['status']): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export const useSessionRuntimeStore = create<SessionRuntimeState & SessionRuntimeActions>((set, get) => ({
    goals: {},
    runningJobs: {},

    setGoal: (goal) => {
        set((state) => ({ goals: { ...state.goals, [goal.sessionId]: goal } }));
    },

    loadGoal: async (sessionId) => {
        const res = await fetchGoalApi(sessionId);
        if (res.code === SUCCESS_CODE && res.data) get().setGoal(res.data);
    },

    disarmGoal: async (sessionId) => {
        const res = await disarmGoalApi(sessionId);
        if (res.code === SUCCESS_CODE && res.data) get().setGoal(res.data);
    },

    setJob: (job) => {
        set((state) => {
            const next = { ...state.runningJobs };
            if (isTerminal(job.status)) delete next[job.id];
            else next[job.id] = job;
            return {
                runningJobs: next,
                ...(isTerminal(job.status) ? { lastFinishedJob: job } : {})
            };
        });
    },

    reset: () => set({ goals: {}, runningJobs: {}, lastFinishedJob: undefined })
}));
