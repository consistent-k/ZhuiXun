import { create } from 'zustand';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchPersonasApi, type PersonaConfigView, type PersonaView } from '@/services';

interface PersonaState {
    defaultId: string;
    items: PersonaView[];
    hydrated: boolean;
}

interface PersonaActions {
    /** 从后端拉取一次；并发/重复调用共享同一 promise。 */
    hydrate: () => Promise<void>;
    /** 用后端返回的完整配置替换镜像。 */
    applyConfig: (config: PersonaConfigView) => void;
    /** 强制重拉（设置页批量操作后可用）。 */
    refresh: () => Promise<void>;
}

let hydratePromise: Promise<void> | null = null;

/**
 * 风格配置的运行时镜像。真源在 backend settings.json；
 * 与 appConfigStore 一致不落 localStorage，避免与后端分叉。
 */
export const usePersonaStore = create<PersonaState & PersonaActions>((set) => ({
    defaultId: 'default',
    items: [],
    hydrated: false,

    hydrate: () => {
        if (hydratePromise) return hydratePromise;
        hydratePromise = (async () => {
            const res = await fetchPersonasApi();
            if (res.code === SUCCESS_CODE && res.data) {
                set({ defaultId: res.data.defaultId, items: res.data.items, hydrated: true });
            } else {
                set({ hydrated: true });
            }
        })();
        return hydratePromise;
    },

    applyConfig: (config) => set({ defaultId: config.defaultId, items: config.items, hydrated: true }),

    refresh: async () => {
        const res = await fetchPersonasApi();
        if (res.code === SUCCESS_CODE && res.data) {
            set({ defaultId: res.data.defaultId, items: res.data.items, hydrated: true });
        }
    }
}));
