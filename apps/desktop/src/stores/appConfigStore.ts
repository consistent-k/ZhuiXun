import { create } from 'zustand';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchAppSettingsApi, type AgentMode } from '@/services';

/**
 * 应用级偏好 store。真源在后端 settings.json（`app` 段），本 store 是运行时镜像：
 * 启动时 `hydrate()` 拉一次，设置页保存后同步更新，chat 发起请求时读取 `defaultAgentMode`。
 * 不持久化到 localStorage（避免与后端真源分叉）。
 */
interface AppConfigState {
    defaultAgentMode: AgentMode;
    hydrated: boolean;
}

interface AppConfigActions {
    setDefaultAgentMode: (mode: AgentMode) => void;
    /** 从后端拉取一次（去重：并发/重复调用共享同一 promise）。 */
    hydrate: () => Promise<void>;
}

let hydratePromise: Promise<void> | null = null;

export const useAppConfigStore = create<AppConfigState & AppConfigActions>((set) => ({
    defaultAgentMode: 'routed',
    hydrated: false,
    setDefaultAgentMode: (mode) => set({ defaultAgentMode: mode }),
    hydrate: () => {
        if (hydratePromise) return hydratePromise;
        hydratePromise = (async () => {
            const res = await fetchAppSettingsApi();
            if (res.code === SUCCESS_CODE && res.data) {
                set({ defaultAgentMode: res.data.defaultAgentMode, hydrated: true });
            } else {
                set({ hydrated: true });
            }
        })();
        return hydratePromise;
    }
}));
