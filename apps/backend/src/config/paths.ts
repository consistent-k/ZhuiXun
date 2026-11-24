import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optional } from './env';

/**
 * 用户可写数据根：会话 / 技能 / 记忆 / 权限 / 日志 / MCP 配置等所有落盘都收在这里，
 * 而非代码库或只读 resources。基于 os.homedir()，dev（tsx 跑 src）与打包（app.js 在
 * 只读 resources）两形态指向同一目录，规避 __dirname 含义在两形态漂移的已知问题。
 */
export const ZHUIXUN_HOME = path.join(os.homedir(), '.zhuixun');

/**
 * 解析用户数据路径：显式覆盖（环境变量值）优先，否则回落到 ZHUIXUN_HOME 下的子路径。
 *
 * @param envOverride 环境变量值（如 SESSIONS_USER_DIR），为空/未设时用默认段
 * @param segments    默认位置在 ZHUIXUN_HOME 下的子路径段（不传则取根本身）
 */
export function resolveUserPath(envOverride: string | undefined, ...segments: string[]): string {
    const override = envOverride?.trim();
    return override ? override : path.join(ZHUIXUN_HOME, ...segments);
}

/**
 * 幂等创建目录，失败只告警不抛（缺目录时由上层各自降级）。返回是否成功。
 *
 * 刻意用 console.warn 而非结构化 logger：paths 是最底层路径工具，logging 模块（及其文件 sink）
 * 反过来要靠 paths 解析日志目录，若再反向依赖 logging 会形成循环导入。
 */
export function ensureDirSafe(dir: string, context?: string): boolean {
    try {
        fs.mkdirSync(dir, { recursive: true });
        return true;
    } catch (error) {
        console.warn('[Paths] 创建目录失败', { dir, context, err: error instanceof Error ? error.message : error });
        return false;
    }
}

/**
 * 各用户数据路径的唯一来源：把此前散在各 store / app.ts 里的
 * `resolveUserPath(process.env.XXX_USER_DIR, '<seg>')` 收成一处，
 * 环境变量名与默认段名不再分离。全部「调用时求值」（晚于 bootstrap-settings 引导）。
 */
export const paths = {
    /** 数据集身份跟随会话存储根，端口变化不影响 UI 恢复。 */
    workspaceIdentityFile: (): string => path.join(paths.sessionsDir(), '.workspace-instance-id'),
    /** 主技能根：~/.zhuixun/skills（SKILLS_USER_DIR 可覆盖）。 */
    skillsDir: (): string => resolveUserPath(optional('SKILLS_USER_DIR'), 'skills'),

    /**
     * 外部只读技能根：SKILLS_EXTERNAL_DIRS（path.delimiter 分隔）覆盖，
     * 否则回落 ~/.agents/skills + ~/.agents（兼容跨工具技能约定，只发现不写入）。
     */
    externalSkillDirs: (): string[] => {
        const raw = optional('SKILLS_EXTERNAL_DIRS');
        const dirs = raw
            ? raw.split(path.delimiter)
            : [path.join(os.homedir(), '.agents', 'skills'), path.join(os.homedir(), '.agents')];
        return dirs.map((d) => d.trim()).filter(Boolean);
    },

    /** MCP 配置文件：~/.zhuixun/.mcp.json（MCP_CONFIG_PATH 可覆盖）。 */
    mcpConfigPath: (): string => resolveUserPath(optional('MCP_CONFIG_PATH'), '.mcp.json'),

    /** 应用配置文件：~/.zhuixun/settings.json（SETTINGS_CONFIG_PATH 可覆盖）。模型配置 + env 覆盖的真源。 */
    settingsPath: (): string => resolveUserPath(optional('SETTINGS_CONFIG_PATH'), 'settings.json'),

    /** MCP OAuth 持久化文件：~/.zhuixun/mcp-oauth.json（含 token，0600 落盘，重启复用）。 */
    mcpOAuthFile: (): string => resolveUserPath(optional('MCP_OAUTH_PATH'), 'mcp-oauth.json'),

    /** 可恢复流落盘根：~/.zhuixun/streams（进程重启后重连回放的缓冲，TTL 过期清理）。 */
    streamsDir: (): string => resolveUserPath(optional('STREAMS_USER_DIR'), 'streams'),

    /** 单个可恢复流缓冲文件：<streamsDir>/<chatId>.ndjson。 */
    streamFile: (chatId: string): string => path.join(paths.streamsDir(), `${chatId}.ndjson`),

    /** 会话根：~/.zhuixun/sessions（SESSIONS_USER_DIR 可覆盖）。 */
    sessionsDir: (): string => resolveUserPath(optional('SESSIONS_USER_DIR'), 'sessions'),

    /** 单会话对话附件目录：<sessionsDir>/<sid>/uploads（图片/PDF 等上传文件落此，随会话删除清理）。 */
    sessionUploadsDir: (sid: string): string => path.join(paths.sessionsDir(), sid, 'uploads'),

    /** 记忆根：~/.zhuixun/memory（MEMORY_USER_DIR 可覆盖）。根下即全局记忆；项目层记忆在各项目目录的 memory/ 子目录。 */
    memoryDir: (): string => resolveUserPath(optional('MEMORY_USER_DIR'), 'memory'),

    /** 权限文件所在目录：~/.zhuixun（PERMISSION_USER_DIR 可覆盖，无子段）。 */
    permissionDir: (): string => resolveUserPath(optional('PERMISSION_USER_DIR')),

    /** 权限文件：<permissionDir>/permissions.json。 */
    permissionFile: (): string => path.join(paths.permissionDir(), 'permissions.json'),

    /**
     * 团队外部权限基线：~/.zhuixun/policy/permissions.json（PERMISSION_POLICY_PATH 可覆盖）。
     * 存在且合法时整体替换内置基线；应用只读不写。
     */
    policyFile: (): string => resolveUserPath(optional('PERMISSION_POLICY_PATH'), 'policy', 'permissions.json'),

    /** Hooks 配置：~/.zhuixun/hooks.json（HOOKS_CONFIG_PATH 可覆盖）。仅手工编辑，经 hash 信任后才执行。 */
    hooksFile: (): string => resolveUserPath(optional('HOOKS_CONFIG_PATH'), 'hooks.json'),

    /** slash 命令根：~/.zhuixun/commands（COMMANDS_USER_DIR 可覆盖）。每命令一个 `<name>.md`。 */
    commandsDir: (): string => resolveUserPath(optional('COMMANDS_USER_DIR'), 'commands'),

    /** 项目根：~/.zhuixun/projects（PROJECTS_USER_DIR 可覆盖）。 */
    projectsDir: (): string => resolveUserPath(optional('PROJECTS_USER_DIR'), 'projects'),

    /** 日志根：~/.zhuixun/logs（LOG_DIR 可覆盖）。 */
    logsDir: (): string => resolveUserPath(optional('LOG_DIR'), 'logs'),

    /** 渠道凭据根：~/.zhuixun/channels（CHANNELS_USER_DIR 可覆盖）。各渠道账号/游标落此，0600。 */
    channelsDir: (): string => resolveUserPath(optional('CHANNELS_USER_DIR'), 'channels'),

    /** 任务清单根：~/.zhuixun/tasks（TASKS_USER_DIR 可覆盖）。每会话一文件 <sid>.json，随会话删除清理。 */
    tasksDir: (): string => resolveUserPath(optional('TASKS_USER_DIR'), 'tasks'),

    /** 单会话任务清单文件：<tasksDir>/<sid>.json。 */
    tasksFile: (sid: string): string => path.join(paths.tasksDir(), `${sid}.json`),

    /**
     * 自动化任务根：~/.zhuixun/automations（AUTOMATIONS_USER_DIR 可覆盖）。
     * 全部定义 + 近期运行台账落在该目录的 index.json（跨会话、非每会话一文件，与 tasksDir 不同）。
     */
    automationsDir: (): string => resolveUserPath(optional('AUTOMATIONS_USER_DIR'), 'automations'),

    /** 自动化任务定义与台账文件：<automationsDir>/index.json。 */
    automationsFile: (): string => path.join(paths.automationsDir(), 'index.json'),

    /**
     * 后台任务（Job）根：~/.zhuixun/jobs（JOBS_USER_DIR 可覆盖）。
     * 与自动化任务分开落盘：Job 是一次性长跑记录，不与调度定义混在一起。
     */
    jobsDir: (): string => resolveUserPath(optional('JOBS_USER_DIR'), 'jobs'),

    /** 后台任务记录文件：<jobsDir>/index.json。 */
    jobsFile: (): string => path.join(paths.jobsDir(), 'index.json'),

    /**
     * shell 审计日志目录：~/.zhuixun/audit。
     * 刻意不提供 env 覆盖：危险跳过审批模式下它是唯一事后追溯手段，不应能被 settings.json 的 env 段改写去向；
     * 也不放在 logs/ 下，避免被日志的按天保留清理误删。
     */
    auditDir: (): string => path.join(ZHUIXUN_HOME, 'audit'),

    /** shell 审计日志文件：<auditDir>/shell-audit.jsonl（每条 Bash/Write 追加一行 JSON）。 */
    auditFile: (): string => path.join(paths.auditDir(), 'shell-audit.jsonl'),

    /** Web 访问审计文件：<auditDir>/web-audit.jsonl（每次 WebFetch 追加一行，不记录正文）。 */
    webAuditFile: (): string => path.join(paths.auditDir(), 'web-audit.jsonl'),

    /** 权限策略审计文件：<auditDir>/permission-audit.jsonl（deny / ask / 按规则 allow 各追加一行）。 */
    permissionAuditFile: (): string => path.join(paths.auditDir(), 'permission-audit.jsonl'),

    /** Hooks 执行审计文件：<auditDir>/hooks-audit.jsonl（不记 stdin，避免落工具入参中的敏感个人信息）。 */
    hooksAuditFile: (): string => path.join(paths.auditDir(), 'hooks-audit.jsonl'),

    /** 自动化任务审计文件：<auditDir>/automation-audit.jsonl（创建/派发/结算/misfire 各追加一行）。 */
    automationAuditFile: (): string => path.join(paths.auditDir(), 'automation-audit.jsonl')
};
