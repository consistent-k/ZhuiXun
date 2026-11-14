import { create } from 'zustand';

import { SUCCESS_CODE } from '@/constant/code';
import {
    createProjectApi,
    deleteProjectApi,
    fetchProjectsApi,
    restoreProjectApi,
    trustProjectApi,
    updateProjectApi
} from '@/services';
import type { ProjectMeta, ProjectUpsertInput } from '@/types/project';

interface ProjectState {
    /** 项目列表元信息，启动时从后端 hydrate */
    projects: ProjectMeta[];
    /** 当前选中的项目 id：用于「新建会话」的默认归属目标。运行时态，不持久化 */
    currentProjectId: string | null;
    /** 列表是否已从后端加载完成 */
    listLoaded: boolean;
}

interface ProjectActions {
    /** 启动时从后端加载项目列表，幂等 */
    hydrate: () => Promise<void>;
    /** 创建项目：写穿后端成功后入内存并选中，返回新项目 id（失败返回 null） */
    createProject: (input: ProjectUpsertInput) => Promise<string | null>;
    /** 更新项目（名称/指令/技能集/归档等）：写穿后端后同步内存元信息 */
    updateProject: (id: string, input: ProjectUpsertInput) => Promise<void>;
    /** 删除项目：默认软删（可从回收站恢复），乐观移出列表 */
    deleteProject: (id: string) => Promise<void>;
    /** 彻底删除项目（回收站用）：cascade=true 连同会话一起删 */
    hardDeleteProject: (id: string, cascade?: boolean) => Promise<void>;
    /** 恢复软删项目：成功后加回列表 */
    restoreProject: (id: string) => Promise<void>;
    /** 切换项目信任态：写穿后端后同步内存元信息 */
    trustProject: (id: string, trusted: boolean) => Promise<void>;
    setCurrentProject: (projectId: string | null) => void;
}

// hydrate 去重：React StrictMode 会重复触发挂载 effect，用共享 promise 保证只加载一次
let hydratePromise: Promise<void> | null = null;

export const useProjectStore = create<ProjectState & ProjectActions>((set) => ({
    projects: [],
    currentProjectId: null,
    listLoaded: false,

    hydrate: () => {
        if (hydratePromise) return hydratePromise;
        hydratePromise = (async () => {
            try {
                const res = await fetchProjectsApi();
                if (res.code === SUCCESS_CODE && res.data) set({ projects: res.data });
            } catch (err) {
                console.error('[projectStore] 加载项目列表失败:', err);
            } finally {
                set({ listLoaded: true });
            }
        })();
        return hydratePromise;
    },

    createProject: async (input) => {
        const res = await createProjectApi(input);
        if (res.code !== SUCCESS_CODE || !res.data) return null;
        const meta = res.data;
        set((state) => ({
            projects: [meta, ...state.projects.filter((p) => p.id !== meta.id)],
            currentProjectId: meta.id
        }));
        return meta.id;
    },

    updateProject: async (id, input) => {
        const res = await updateProjectApi(id, input);
        if (res.code !== SUCCESS_CODE || !res.data) return;
        const meta = res.data;
        set((state) => ({ projects: state.projects.map((p) => (p.id === id ? meta : p)) }));
    },

    deleteProject: async (id) => {
        // 软删：乐观移除内存中的项目（仍可从回收站恢复）；会话归属不变
        set((state) => ({
            projects: state.projects.filter((p) => p.id !== id),
            currentProjectId: state.currentProjectId === id ? null : state.currentProjectId
        }));
        await deleteProjectApi(id);
    },

    hardDeleteProject: async (id, cascade = false) => {
        set((state) => ({
            projects: state.projects.filter((p) => p.id !== id),
            currentProjectId: state.currentProjectId === id ? null : state.currentProjectId
        }));
        await deleteProjectApi(id, { hard: true, cascade });
    },

    restoreProject: async (id) => {
        const res = await restoreProjectApi(id);
        if (res.code !== SUCCESS_CODE || !res.data) return;
        const meta = res.data;
        set((state) => ({ projects: [meta, ...state.projects.filter((p) => p.id !== meta.id)] }));
    },

    trustProject: async (id, trusted) => {
        const res = await trustProjectApi(id, trusted);
        if (res.code !== SUCCESS_CODE || !res.data) return;
        const meta = res.data;
        set((state) => ({ projects: state.projects.map((p) => (p.id === id ? meta : p)) }));
    },

    setCurrentProject: (projectId) => set({ currentProjectId: projectId })
}));

/** 便捷 selector：按 id 取项目名（找不到返回 undefined） */
export function selectProjectName(id: string | null | undefined): string | undefined {
    if (!id) return undefined;
    return useProjectStore.getState().projects.find((p) => p.id === id)?.name;
}
