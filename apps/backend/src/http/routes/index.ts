/**
 * 路由层唯一公开面：组合根（`bootstrap/app.ts`）只从这里取全部 router，
 * 不再逐个 import 具体路由文件。
 *
 * 新增路由时在此加一行 re-export，再在 `bootstrap/app.ts` 的登记表里挂载。
 * 注意：路由文件**不要**反向 import 本文件（会形成 routes/index ↔ routes/<域> 的循环），
 * 路由之间需要复用的逻辑下沉到 `http/middleware` 或对应 `modules/*`。
 */
export { createAutomationRouter } from './automation';
export { createChannelsRouter } from './channels';
export { createChatRouter } from './chat';
export { createCommandsRouter } from './commands';
export { createConversationsRouter } from './conversations';
export { createDebugRouter } from './debug';
export { createGoalRouter } from './goal';
export { createHealthRouter } from './health';
export { createHooksRouter } from './hooks';
export { createJobsRouter } from './jobs';
export { createSessionRouter } from './session';
export { createLogsRouter } from './logs';
export { createMCPRouter } from './mcp';
export { createMemoryRouter } from './memory';
export { createPermissionRouter } from './permission';
export { createPersonaRouter } from './persona';
export { createProjectsRouter } from './projects';
export { default as settingsRouter } from './settings';
export { createSkillHubRouter } from './skillhub';
export { createSkillsRouter } from './skills';
export { createToolsRouter } from './tools';
