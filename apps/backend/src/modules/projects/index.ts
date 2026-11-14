/** projects 模块公开契约：项目元数据、知识文件与工作目录探活。 */
export type { ProjectMeta, ProjectRoot, ProjectUpsert, SavedProject } from './store';
export {
    allRootPaths,
    buildInjectedProject,
    createProjectStore,
    getProjectStore,
    isValidProjectId,
    normalizeRoots,
    primaryRootPath
} from './store';
export type { ResolvedRoots } from './roots';
export { resolveEffectiveRoots, validateDir } from './roots';
