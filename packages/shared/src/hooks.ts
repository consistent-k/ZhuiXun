/** Hooks 状态：未配置 / 解析错误 / 待信任（文件新建或被改动）/ 已停用（总开关关）/ 已启用。 */
export type HooksStatus = 'absent' | 'error' | 'untrusted' | 'disabled' | 'active';

/** Hook 事件。 */
export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'Stop';

/** GET /api/hooks 的视图（配置只读展示，hooks.json 仅手工编辑）。 */
export interface HooksView {
    /** hooks.json 绝对路径 */
    path: string;
    status: HooksStatus;
    /** 总开关 */
    enabled: boolean;
    /** 当前文件内容 sha256（文件存在时） */
    hash?: string;
    /** 当前文件内容是否已被信任（hash 与已信任 hash 一致） */
    trusted: boolean;
    /** 文件原文（存在时，供用户确认前审阅） */
    content?: string;
    /** 解析错误说明 */
    error?: string;
    /** 各事件已配置的 hook 命令数 */
    counts: Record<HookEventName, number>;
}

/** 一次 hook 执行的审计记录（不含 stdin，避免落工具入参中的敏感个人信息）。 */
export interface HookAuditEntry {
    ts: string;
    event: HookEventName;
    toolName?: string;
    matcher?: string;
    /** 命令原文截断 200 字 */
    command: string;
    exitCode: number | null;
    durationMs: number;
    timedOut?: boolean;
    /** 该 hook 的结论：allow / deny / ask / none / error */
    decision: string;
}
