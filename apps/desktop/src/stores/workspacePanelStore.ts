import type { WorkspaceFileReference, WorkspaceSummary } from '@zhuixun/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchWorkspaceApi, fetchWorkspaceIdentityApi } from '@/services/workspace';
import { staticApi } from '@/utils/antdStatic';

export interface FileTab {
    id: string;
    reference: WorkspaceFileReference;
    line?: number;
}
export interface PanelState {
    tabs: FileTab[];
    active: string;
    open: boolean;
}
export const EMPTY_PANEL: PanelState = { tabs: [], active: 'summary', open: false };
const EMPTY_SUMMARIES: WorkspaceSummary[] = [];
interface State {
    instance: string;
    identityError: string;
    panels: Record<string, PanelState>;
    summaries: Record<string, WorkspaceSummary[]>;
    summaryErrors: Record<string, string>;
    width: number;
    initialize: () => Promise<void>;
    load: (id: string) => Promise<void>;
    receive: (summary: WorkspaceSummary) => void;
    change: (id: string, update: (state: PanelState) => PanelState) => void;
    openFile: (id: string, reference: WorkspaceFileReference, resourceKey?: string) => void;
    closeFile: (id: string, tab: string) => void;
    setWidth: (width: number) => void;
    forget: (id: string) => void;
}
let identityPromise: Promise<void> | undefined;
const loadVersions = new Map<string, number>();

/** 业务摘要不进 UI 持久快照；标签以稳定引用恢复，不保存 fileId/Blob/临时授权。 */
export const useWorkspacePanelStore = create<State>()(
    persist(
        (set, get) => ({
            instance: '',
            identityError: '',
            panels: {},
            summaries: {},
            summaryErrors: {},
            width: 420,
            initialize: () => {
                identityPromise ??= (async () => {
                    const res = await fetchWorkspaceIdentityApi();
                    if (res.code === SUCCESS_CODE && res.data)
                        set({ instance: res.data.workspaceInstanceId, identityError: '' });
                    else {
                        set({ identityError: res.message ?? '无法恢复工作面板，请重试' });
                        identityPromise = undefined;
                    }
                })();
                return identityPromise;
            },
            load: async (id) => {
                const version = (loadVersions.get(id) ?? 0) + 1;
                loadVersions.set(id, version);
                const before = get().summaries[id] ?? [];
                const result = await fetchWorkspaceApi(id);
                if (loadVersions.get(id) !== version) return;
                if (result.code !== SUCCESS_CODE || !result.data) {
                    set((state) => ({
                        summaryErrors: {
                            ...state.summaryErrors,
                            [id]: result.code === 404 ? '' : (result.message ?? '摘要加载失败')
                        }
                    }));
                    return;
                }
                const previous = get().summaries[id] ?? [];
                // GET 可能晚于实时事件返回，按轮 revision 合并，且移除已回滚的轮次。
                const summaries = result.data.map((s) => {
                    const live = previous.find((p) => p.turnId === s.turnId);
                    return live && live.revision > s.revision ? live : s;
                });
                for (const live of previous) {
                    if (
                        !summaries.some((s) => s.turnId === live.turnId) &&
                        !before.some((s) => s.turnId === live.turnId && s.revision >= live.revision)
                    )
                        summaries.push(live);
                }
                set((state) => ({
                    summaries: { ...state.summaries, [id]: summaries },
                    summaryErrors: { ...state.summaryErrors, [id]: '' }
                }));
                const validTurns = new Set(summaries.map((s) => s.turnId));
                get().change(id, (panel) => {
                    const tabs = panel.tabs.filter(
                        (tab) => !tab.reference.turnId || validTurns.has(tab.reference.turnId)
                    );
                    return {
                        ...panel,
                        tabs,
                        active: tabs.some((tab) => tab.id === panel.active) ? panel.active : (tabs[0]?.id ?? 'summary'),
                        open: panel.open && tabs.length > 0
                    };
                });
            },
            receive: (summary) =>
                set((state) => {
                    const previous = state.summaries[summary.conversationId] ?? [];
                    if (previous.some((s) => s.turnId === summary.turnId && s.revision >= summary.revision))
                        return state;
                    const next = previous.some((s) => s.turnId === summary.turnId)
                        ? previous.map((s) => (s.turnId === summary.turnId ? summary : s))
                        : [...previous, summary];
                    return { summaries: { ...state.summaries, [summary.conversationId]: next } };
                }),
            change: (id, update) => {
                const instance = get().instance;
                if (!instance) return;
                const key = `${instance}:${id}`;
                set((state) => ({ panels: { ...state.panels, [key]: update(state.panels[key] ?? EMPTY_PANEL) } }));
            },
            openFile: (id, reference, resourceKey) =>
                get().change(id, (panel) => {
                    const key =
                        resourceKey ??
                        `${reference.kind}:${reference.kind === 'workspace' ? reference.path : reference.attachmentId}`;
                    const existing = panel.tabs.find((t) => t.id === key);
                    const tab = {
                        id: key,
                        reference,
                        line: reference.kind === 'workspace' ? reference.line : undefined
                    };
                    return {
                        ...panel,
                        tabs: existing ? panel.tabs.map((t) => (t.id === key ? tab : t)) : [...panel.tabs, tab],
                        active: key,
                        open: true
                    };
                }),
            closeFile: (id, tab) =>
                get().change(id, (panel) => {
                    const index = panel.tabs.findIndex((t) => t.id === tab);
                    const tabs = panel.tabs.filter((t) => t.id !== tab);
                    return {
                        ...panel,
                        tabs,
                        active: panel.active === tab ? (tabs[Math.max(0, index - 1)]?.id ?? 'summary') : panel.active,
                        open: panel.open && tabs.length > 0
                    };
                }),
            setWidth: (width) => set({ width: Math.max(280, Math.min(720, width)) }),
            forget: (id) =>
                set((state) => ({
                    panels: Object.fromEntries(Object.entries(state.panels).filter(([key]) => !key.endsWith(`:${id}`))),
                    summaries: Object.fromEntries(Object.entries(state.summaries).filter(([key]) => key !== id))
                }))
        }),
        {
            name: 'zhuixun-workspace-panel',
            version: 1,
            partialize: (state) => ({ panels: state.panels, width: state.width }),
            storage: createJSONStorage(() => ({
                getItem: (key) => localStorage.getItem(key),
                setItem: (key, value) => {
                    try {
                        localStorage.setItem(key, value);
                    } catch {
                        staticApi.message?.warning('面板状态保存失败，重启后可能无法恢复');
                    }
                },
                removeItem: (key) => localStorage.removeItem(key)
            })),
            merge: (persisted, current) => {
                const saved = persisted as { width?: number; panels?: Record<string, PanelState> } | undefined;
                const panels: Record<string, PanelState> = {};
                for (const [key, panel] of Object.entries(saved?.panels ?? {})) {
                    if (!panel || !Array.isArray(panel.tabs) || typeof panel.active !== 'string') continue;
                    const tabs = panel.tabs.filter(
                        (t) =>
                            t &&
                            typeof t.id === 'string' &&
                            t.reference &&
                            typeof t.reference.name === 'string' &&
                            ((t.reference.kind === 'workspace' && typeof t.reference.path === 'string') ||
                                (t.reference.kind === 'attachment' && typeof t.reference.attachmentId === 'string'))
                    );
                    panels[key] = {
                        tabs,
                        active: tabs.some((t) => t.id === panel.active) ? panel.active : 'summary',
                        // 旧版 Summary 标签不再恢复为分栏，只有文件预览可恢复打开状态。
                        open: panel.open === true && tabs.some((t) => t.id === panel.active)
                    };
                }
                return {
                    ...current,
                    panels,
                    width:
                        typeof saved?.width === 'number' && Number.isFinite(saved.width)
                            ? Math.max(280, Math.min(720, saved.width))
                            : 420
                };
            }
        }
    )
);
/** 精确订阅当前会话面板，避免每个 token 更新整个页面。 */
export function useConversationPanel(id: string) {
    return useWorkspacePanelStore((state) => state.panels[`${state.instance}:${id}`] ?? EMPTY_PANEL);
}
/** 摘要只随结构化结果变化。 */
export function useWorkspaceSummaries(id: string) {
    return useWorkspacePanelStore((state) => state.summaries[id] ?? EMPTY_SUMMARIES);
}
