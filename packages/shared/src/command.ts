/** slash 命令摘要（列表 / 输入框联想用，不含正文）。 */
export interface CommandSummary {
    /** 命令名（`[a-z0-9-]{1,32}`），输入 `/name` 触发 */
    name: string;
    description?: string;
    /** 参数提示，如 `<文件路径>` */
    argumentHint?: string;
}

/** 单个命令详情（含模板正文）。 */
export interface CommandDetail extends CommandSummary {
    /** 模板正文，支持 `$ARGUMENTS` 与 `$1`…`$9` 占位 */
    body: string;
}

/** PUT /api/commands/:name 的请求体。 */
export interface CommandUpsertInput {
    description?: string;
    argumentHint?: string;
    body: string;
}

/** POST /api/commands/expand 的结果；未命中命令时 matched=false，按普通文本发送。 */
export interface CommandExpandResult {
    matched: boolean;
    name?: string;
    args?: string;
    expanded?: string;
}

/**
 * 用户消息里的 `data-command` part 数据：原文仍在 text part，展开结果随消息走，
 * 后续轮次重发历史时模型看到的是当时的展开快照。
 */
export interface CommandPartData {
    name: string;
    args: string;
    expanded: string;
}
