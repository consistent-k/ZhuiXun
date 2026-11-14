/**
 * commands 模块公开契约：用户 slash 命令宏（`~/.zhuixun/commands/<name>.md`）的 CRUD 与模板展开。
 * 内置命令 `/new` `/help` `/compact` 由前端本地处理，用户命令不得同名。
 */
export type { CommandDetail, CommandExpandResult, CommandSummary, CommandUpsertInput } from '@zhuixun/shared';
export {
    BUILTIN_COMMAND_NAMES,
    BUILTIN_COMMANDS,
    expandCommandText,
    expandTemplate,
    parseCommandInvocation,
    splitArgs
} from './expand';
export { CommandError, CommandStore, getCommandStore } from './store';
