import { create } from 'zustand';

import { SUCCESS_CODE } from '@/constant/code';
import {
    createAutomationApi,
    deleteAutomationApi,
    fetchAutomationsApi,
    runAutomationApi,
    setAutomationEnabledApi,
    subscribeAutomationEvents,
    updateAutomationApi
} from '@/services';
import type {
    AutomationCreateRequest,
    AutomationFilter,
    AutomationUpdateRequest,
    AutomationView
} from '@/types/automation';

interface AutomationState {
    /** 任务列表（后端为唯一真源，本地仅镜像） */
    automations: AutomationView[];
    /** 当前筛选态 */
    filter: AutomationFilter;
    /** 列表加载中 */
    loading: boolean;
    /** 未查看的完成事件数：侧栏「自动化任务」角标 */
    unseenSettles: number;
}

interface AutomationActions {
    /** 按当前筛选态从后端拉取列表 */
    refresh: () => Promise<void>;
    setFilter: (filter: AutomationFilter) => Promise<void>;
    create: (input: AutomationCreateRequest) => Promise<boolean>;
    update: (id: string, input: AutomationUpdateRequest) => Promise<boolean>;
    remove: (id: string) => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
    runNow: (id: string) => Promise<string | null>;
    /** 记一次任务完成（全局 SSE 调用），累加未查看角标 */
    noteSettle: () => void;
    /** 打开管理页时清除角标 */
    clearUnseen: () => void;
    /** 挂载 SSE 订阅：收到事件就地刷新。返回取消订阅函数，页面卸载时调用 */
    subscribe: () => () => void;
}

/** 就地替换列表中的一条（后端返回最新视图后同步镜像） */
function replaceOne(list: AutomationView[], next: AutomationView): AutomationView[] {
    return list.map((a) => (a.id === next.id ? next : a));
}

export const useAutomationStore = create<AutomationState & AutomationActions>((set, get) => ({
    automations: [],
    filter: 'all',
    loading: false,
    unseenSettles: 0,

    refresh: async () => {
        set({ loading: true });
        try {
            const res = await fetchAutomationsApi(get().filter);
            if (res.code === SUCCESS_CODE && res.data) set({ automations: res.data });
        } finally {
            set({ loading: false });
        }
    },

    setFilter: async (filter) => {
        set({ filter });
        await get().refresh();
    },

    create: async (input) => {
        const res = await createAutomationApi(input);
        if (res.code !== SUCCESS_CODE || !res.data) return false;
        // 新建后重拉：当前筛选态可能不含新任务，交给后端按 filter 决定可见性
        await get().refresh();
        return true;
    },

    update: async (id, input) => {
        const res = await updateAutomationApi(id, input);
        if (res.code !== SUCCESS_CODE || !res.data) return false;
        set((state) => ({ automations: replaceOne(state.automations, res.data!) }));
        return true;
    },

    remove: async (id) => {
        const res = await deleteAutomationApi(id);
        if (res.code === SUCCESS_CODE) {
            set((state) => ({ automations: state.automations.filter((a) => a.id !== id) }));
        }
    },

    setEnabled: async (id, enabled) => {
        const res = await setAutomationEnabledApi(id, enabled);
        if (res.code === SUCCESS_CODE && res.data) {
            // 筛选态为 enabled/inactive 时，启停会改变可见性，重拉以反映过滤结果
            if (get().filter === 'all') set((state) => ({ automations: replaceOne(state.automations, res.data!) }));
            else await get().refresh();
        }
    },

    runNow: async (id) => {
        const res = await runAutomationApi(id);
        return res.code === SUCCESS_CODE && res.data ? res.data.runId : null;
    },

    noteSettle: () => set((state) => ({ unseenSettles: state.unseenSettles + 1 })),

    clearUnseen: () => set({ unseenSettles: 0 }),

    subscribe: () => {
        return subscribeAutomationEvents(() => {
            // dispatch / settle / changed 都可能改变行状态或列表构成，统一重拉保证与后端一致
            void get().refresh();
        });
    }
}));
