/** 一条已记忆的 Bash 命令头放行规则（永久规则落盘）。 */
export interface BashRule {
    /** 规则唯一 id */
    id: string;
    /** 命令头（如 `git status`），自动放行按它匹配 */
    head: string;
    /** 创建时间戳（ms） */
    createdAt: number;
}

/** 一条已记忆的 Write 目录放行规则。写入目标在该目录或其子目录内即自动放行。 */
export interface WriteRule {
    /** 规则唯一 id */
    id: string;
    /** 规范化的绝对目录前缀（如 `/Users/x/proj/src`） */
    dir: string;
    /** 创建时间戳（ms） */
    createdAt: number;
}

/** 永久权限数据：一个总开关 + Bash / Write 放行规则列表。 */
export interface PermissionData {
    /** 数据版本，便于将来迁移 */
    version: number;
    /** 自动放行总开关：关闭后所有命令都要用户确认（不删规则，仅停用） */
    autoApprovalEnabled: boolean;
    bash: {
        /** 已记忆的命令头放行规则 */
        allow: BashRule[];
    };
    write: {
        /** 已记忆的目录放行规则 */
        allow: WriteRule[];
    };
    /** 用户声明式规则（v3 起）；v2 文件读入时补空 */
    rules: PermissionRuleSet;
}

/** 记住范围：仅本次会话（内存）/ 永久（落盘）。 */
export type RememberScope = 'session' | 'permanent';

/** 记忆一条命令/目录的结果：成功返回规则，被拒绝 / 降级时 rule 为 null 并给出原因。 */
export interface RememberResult {
    /** 落下的规则；被拒记或降级时为 null */
    rule: BashRule | WriteRule | null;
    /** 未落规则的原因 */
    skipped?: 'compound' | 'unsafe' | 'denylisted' | 'no-session' | 'relative';
}

/** 声明式权限规则集：每条形如 `Tool` 或 `Tool(specifier)`，如 `Bash(git push:*)`、`Read(~/.ssh/x)`。 */
export interface PermissionRuleSet {
    deny: string[];
    ask: string[];
    allow: string[];
}

/** 规则判定结果：deny 拒绝 / ask 需确认 / allow 免确认 / none 未命中（交给既有审批）。 */
export type PolicyDecisionKind = 'deny' | 'ask' | 'allow' | 'none';

/** 命中规则的来源：团队基线 / 用户规则 / 应用硬底线。 */
export type PolicySource = 'baseline' | 'user' | 'floor';

/** 团队基线来源：内置常量 / 外部文件整体替换 / 外部文件损坏（全部工具降级为需确认）。 */
export type BaselineSource = 'builtin' | 'external' | 'invalid';

export interface PolicyDecision {
    decision: PolicyDecisionKind;
    /** 命中的规则原文（floor 为内部标识） */
    rule?: string;
    source?: PolicySource;
    /** 面向用户 / 模型的说明 */
    reason?: string;
}

/** GET /api/permissions/rules 的视图。 */
export interface PolicyRulesView {
    baseline: PermissionRuleSet;
    baselineSource: BaselineSource;
    /** 外部基线文件路径（不论是否存在） */
    baselinePath: string;
    /** 外部基线损坏时的错误说明 */
    baselineError?: string;
    user: PermissionRuleSet;
    /** 加载时被跳过的非法规则（含来源前缀，如 `baseline: Foo(`） */
    invalid: string[];
}

/** POST /api/permissions/rules/evaluate 的结果。 */
export interface PolicyEvaluateResult {
    /** 传入 rule 时为其格式校验结果；未传 rule 恒为 true */
    valid: boolean;
    error?: string;
    /** 传入 toolName 时给出按当前策略的判定 */
    decision?: PolicyDecision;
}

/** 输入框为一轮桌面对话选择的审批方式。 */
export type ApprovalMode = 'ask' | 'auto-review' | 'full-access';
