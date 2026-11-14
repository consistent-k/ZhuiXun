import { optional } from './env';

/**
 * 危险跳过审批模式（对齐 Claude Code 的 `--dangerously-skip-permissions` / `bypassPermissions`）。
 *
 * 语义：进入该模式后，Bash（含 `rm`、复合命令）与 Write 一律不再弹用户确认、直接执行。
 *
 * 安全底线（务必守住）：
 * - **只认服务端启动态**（CLI 参数 / 环境变量），绝不从请求体或模型工具调用派生——否则前端 / 模型
 *   自身即可开启，防护将形同虚设。
 * - **root/uid 0 下强制判为未开启**：最坏情况（root + 全放行 + 真实 shell）从机制上排除，仅告警并
 *   降级为普通审批。
 * - 结果在进程内固化缓存，运行时不变（旗标是启动事实，不是可切换的开关）。
 *
 * 本模块刻意不写日志（config 是叶子层，不得依赖 platform/logging）：启动告警由
 * `bootstrap/services.ts` 读取 `getDangerModeStatus()` 后统一打印。
 */

/** CLI 参数：`node app.js --dangerously-skip-permissions`。 */
const CLI_FLAG = '--dangerously-skip-permissions';
/** 环境变量：`ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS=1`（打包形态用，命名对齐 ZHUIXUN_*）。 */
const ENV_KEY = 'ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS';

/** 环境变量真值判定：仅 1/true/yes/on 视为开启，其余（含空、0、false）一律关闭。 */
function truthy(value: string | undefined): boolean {
    if (!value) return false;
    const s = value.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export interface DangerModeStatus {
    enabled: boolean;
    /** 旗标来源（CLI 参数 / 环境变量），未启用时为 undefined。 */
    source?: string;
    uid?: number;
    /** 因 root/uid 0 被拒绝启用（调用方据此打 error 级启动日志）。 */
    deniedByRoot?: boolean;
}

let cached: DangerModeStatus | undefined;

function resolve(): DangerModeStatus {
    const fromCli = process.argv.includes(CLI_FLAG);
    const fromEnv = truthy(optional(ENV_KEY));
    if (!fromCli && !fromEnv) return { enabled: false };

    const source = fromCli ? `CLI ${CLI_FLAG}` : `env ${ENV_KEY}`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

    // root 守卫：拒绝启用并降级为普通审批（仿 Claude Code）
    if (uid === 0) return { enabled: false, source, uid, deniedByRoot: true };
    return { enabled: true, source, uid };
}

/** 危险模式判定结果（含来源信息，供启动日志使用）。首次调用解析并缓存。 */
export function getDangerModeStatus(): DangerModeStatus {
    if (cached === undefined) cached = resolve();
    return cached;
}

/** 是否进入危险跳过审批模式。 */
export function isDangerouslySkipPermissions(): boolean {
    return getDangerModeStatus().enabled;
}
