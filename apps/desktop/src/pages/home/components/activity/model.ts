import { getToolName, isToolUIPart, type FileUIPart, type ReasoningUIPart, type TextUIPart, type UIMessage } from 'ai';

/**
 * Agent 活动流视图模型：把 AI SDK 的 `UIMessage.parts` 转成可渲染的 `TimelineNode[]`。
 *
 * 这里只做纯函数派生，不改消息、不新增 store：
 * - 连续工具 part 跨 SDK 步骤聚合成一个 `work` 节点；
 * - 思考 / 正文 / 附件是硬边界，遇到即断开当前工具组；
 * - askUserQuestion 与任务清单保持独立节点，不参与折叠。
 */

export type ToolRunStatus =
    'preparing' | 'waiting-approval' | 'running' | 'success' | 'warning' | 'error' | 'denied' | 'canceled';

export type ToolCategory =
    | 'command'
    | 'read'
    | 'write'
    | 'edit'
    | 'search'
    | 'web'
    | 'subagent'
    | 'plan'
    | 'question'
    | 'memory'
    | 'skill'
    | 'mcp'
    | 'other';

/** 工具相关 part（静态 tool-* 与 dynamic-tool 的公共形态） */
export type AnyToolPart = Extract<UIMessage['parts'][number], { toolCallId: string }>;

export interface ToolItem {
    /** tool part 原引用，presenter 从 input/output/state 取数 */
    part: AnyToolPart;
    toolCallId: string;
    toolName: string;
    category: ToolCategory;
    status: ToolRunStatus;
    /** 由策略/hook 自动批准：仍渲染工具卡，但不出现审批卡 */
    autoApproved: boolean;
}

export type TimelineNode =
    | { kind: 'reasoning'; key: string; part: ReasoningUIPart }
    | { kind: 'text'; key: string; part: TextUIPart }
    | { kind: 'file'; key: string; part: FileUIPart }
    | { kind: 'work'; key: string; items: ToolItem[] }
    | { kind: 'task'; key: string; part: AnyToolPart }
    | { kind: 'question'; key: string; part: AnyToolPart };

/** 交互提问工具（后端 agent/tools/interaction-tools.ts），需要用户作答，不能折进工具组 */
export const ASK_USER_QUESTION_TOOL = 'askUserQuestion';

/** 任务清单工具（后端 agent/tools/task-tools.ts） */
export const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TaskList']);

/**
 * 内联任务卡片精简策略：标题栏 TaskPanel 已承载「当前」清单，会话流里只保留有独立价值的两类：
 * - TaskCreate：初始计划成形，值得在时间线留痕；
 * - 失败更新（output-error 或 execute 回软错误 ok:false，如被阻塞/成环）：面板不展示失败，需在此可见。
 */
export function shouldShowTaskCard(part: AnyToolPart, toolName: string): boolean {
    if (toolName === 'TaskCreate') return true;
    if (part.state === 'output-error') return true;
    const output = 'output' in part ? part.output : undefined;
    return isSoftFailure(output) && output !== undefined;
}

/** 是否为业务软失败（工具 execute 正常返回，但业务上未生效） */
export function isSoftFailure(output: unknown): boolean {
    if (!output || typeof output !== 'object') return false;
    const record = output as Record<string, unknown>;
    return record.ok === false || record.success === false;
}

/** 软失败的人话原因 */
export function softFailureMessage(output: unknown): string | undefined {
    if (!output || typeof output !== 'object') return undefined;
    const record = output as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

/** Bash 退出码（非零归为 warning，不算工具错误） */
export function bashExitCode(output: unknown): number | null {
    if (!output || typeof output !== 'object') return null;
    const value = (output as Record<string, unknown>).exitCode;
    return typeof value === 'number' ? value : null;
}

export function categorize(toolName: string): ToolCategory {
    if (toolName.startsWith('mcp__')) return 'mcp';
    switch (toolName) {
        case 'Bash':
            return 'command';
        case 'Read':
            return 'read';
        case 'Write':
            return 'write';
        case 'Edit':
            return 'edit';
        case 'Grep':
        case 'Glob':
        case 'LS':
            return 'search';
        case 'WebFetch':
            return 'web';
        case 'Task':
            return 'subagent';
        case 'TaskCreate':
        case 'TaskUpdate':
        case 'TaskList':
            return 'plan';
        case ASK_USER_QUESTION_TOOL:
            return 'question';
        case 'read_memory':
        case 'write_memory':
        case 'delete_memory':
            return 'memory';
        case 'load_skill':
        case 'list_skills':
        case 'create_skill':
        case 'update_skill':
            return 'skill';
        default:
            return 'other';
    }
}

/** AI SDK part 状态 → 统一运行状态 */
export function normalizeToolStatus(part: AnyToolPart): ToolRunStatus {
    switch (part.state) {
        case 'input-streaming':
            return 'preparing';
        case 'input-available':
            return 'running';
        case 'approval-requested':
            // 自动审批不弹卡，直接按执行中展示
            return part.approval.isAutomatic ? 'running' : 'waiting-approval';
        case 'approval-responded':
            return part.approval.approved ? 'running' : 'denied';
        case 'output-denied':
            return 'denied';
        case 'output-error':
            return 'error';
        case 'output-available': {
            if (isSoftFailure(part.output)) return 'warning';
            if (getToolName(part) === 'Bash') {
                const exitCode = bashExitCode(part.output);
                if (exitCode != null && exitCode !== 0) return 'warning';
            }
            return 'success';
        }
        default:
            return 'success';
    }
}

const STATUS_RANK: Record<ToolRunStatus, number> = {
    error: 5,
    denied: 5,
    'waiting-approval': 4,
    running: 3,
    preparing: 2,
    warning: 1,
    success: 0,
    canceled: 0
};

/** 组状态取组内最高优先级 */
export function groupStatus(items: readonly ToolItem[]): ToolRunStatus {
    let current: ToolRunStatus = 'success';
    for (const item of items) {
        if (STATUS_RANK[item.status] > STATUS_RANK[current]) current = item.status;
    }
    return current;
}

export function isActiveStatus(status: ToolRunStatus): boolean {
    return status === 'preparing' || status === 'running' || status === 'waiting-approval';
}

/** 读取工具入参为普通对象；流式半截参数或非对象一律返回空对象 */
export function readInput(item: ToolItem): Record<string, unknown> {
    const part = item.part;
    const input = 'input' in part ? part.input : undefined;
    return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** 读取工具返回；未产出时返回 undefined */
export function readOutput(item: ToolItem): unknown {
    const part = item.part;
    return 'output' in part ? part.output : undefined;
}

export function readOutputRecord(item: ToolItem): Record<string, unknown> {
    const output = readOutput(item);
    return output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>) : {};
}

/** 取对象里第一个非空字符串字段 */
export function readString(record: Record<string, unknown>, keys: readonly string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
}

export function buildTimeline(parts: UIMessage['parts'] = []): TimelineNode[] {
    const nodes: TimelineNode[] = [];
    let bucket: ToolItem[] = [];

    const flush = () => {
        if (bucket.length === 0) return;
        // key 锚定首个 toolCallId：流式追加子项时 key 不变，展开态不会丢
        nodes.push({ kind: 'work', key: `work:${bucket[0].toolCallId}`, items: bucket });
        bucket = [];
    };

    parts.forEach((part, index) => {
        // SDK 每步可能只调用一个工具，步骤标记没有可见内容，不应把连续工具拆成单卡。
        if (part.type === 'step-start') return;
        if (part.type === 'text') {
            if (!part.text) return;
            flush();
            nodes.push({ kind: 'text', key: `text:${index}`, part });
            return;
        }
        if (part.type === 'reasoning') {
            if (!part.text.trim()) return;
            flush();
            // 不能用 part.id：AI SDK 的 reasoning id 形如 reasoning-0，同一消息多个 step 会重复，
            // 直接当 key 会触发 "two children with the same key"；parts 顺序稳定，用 index 唯一。
            nodes.push({ kind: 'reasoning', key: `reasoning:${index}`, part });
            return;
        }
        if (part.type === 'file') {
            flush();
            nodes.push({ kind: 'file', key: `file:${index}`, part });
            return;
        }
        if (!isToolUIPart(part)) return;

        const toolName = getToolName(part);
        if (toolName === ASK_USER_QUESTION_TOOL) {
            flush();
            nodes.push({ kind: 'question', key: part.toolCallId, part });
            return;
        }
        if (TASK_TOOLS.has(toolName)) {
            // 隐藏的成功更新不打断当前工具组
            if (!shouldShowTaskCard(part, toolName)) return;
            flush();
            nodes.push({ kind: 'task', key: part.toolCallId, part });
            return;
        }

        bucket.push({
            part,
            toolCallId: part.toolCallId,
            toolName,
            category: categorize(toolName),
            status: normalizeToolStatus(part),
            autoApproved: 'approval' in part && part.approval?.isAutomatic === true
        });
    });

    flush();
    return nodes;
}

export interface WorkSummary {
    counts: { category: ToolCategory; count: number }[];
    /** 当前正在执行的工具，供组头不展开也能看到进展 */
    running?: { category: ToolCategory; detail: string };
    attention: boolean;
    /** 软失败 / 非零退出码：不强制展开，但组头要有可见提示 */
    warningCount: number;
    allSettled: boolean;
    autoApprovedCount: number;
}

const CATEGORY_ORDER: ToolCategory[] = [
    'command',
    'read',
    'edit',
    'write',
    'search',
    'web',
    'subagent',
    'plan',
    'skill',
    'memory',
    'mcp',
    'question',
    'other'
];

/** 组头分类计数的人话标签 */
export const CATEGORY_LABEL: Record<ToolCategory, string> = {
    command: '命令',
    read: '读取',
    write: '写入',
    edit: '编辑',
    search: '检索',
    web: '网页',
    subagent: '子任务',
    plan: '计划',
    question: '问答',
    memory: '记忆',
    skill: '技能',
    mcp: 'MCP',
    other: '其他'
};

export function summarizeWork(items: readonly ToolItem[]): WorkSummary {
    const counts = new Map<ToolCategory, number>();
    let running: ToolItem | undefined;
    let autoApprovedCount = 0;
    let warningCount = 0;

    for (const item of items) {
        counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
        if (item.autoApproved) autoApprovedCount += 1;
        if (item.status === 'warning') warningCount += 1;
        if (item.status === 'running' || item.status === 'preparing') running = item;
    }

    return {
        counts: CATEGORY_ORDER.filter((category) => counts.has(category)).map((category) => ({
            category,
            count: counts.get(category) ?? 0
        })),
        running: running ? { category: running.category, detail: describeToolInput(running) } : undefined,
        attention: items.some(
            (item) => item.status === 'error' || item.status === 'denied' || item.status === 'waiting-approval'
        ),
        warningCount,
        allSettled: items.every((item) => !isActiveStatus(item.status)),
        autoApprovedCount
    };
}

/** 组头运行中摘要：取工具入参里最有信息量的一个字符串 */
export function describeToolInput(item: ToolItem): string {
    const input = readInput(item);
    const value = readString(input, [
        'command',
        'pattern',
        'path',
        'file_path',
        'url',
        'description',
        'name',
        'skillId'
    ]);
    return value ? value.replace(/\s+/g, ' ').trim() : item.toolName;
}
