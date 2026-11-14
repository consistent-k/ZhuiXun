import fsp from 'node:fs/promises';

import type { ApprovalMode, BaselineSource, PermissionRuleSet, PolicyDecision, PolicyRulesView } from '@zhuixun/shared';
import dayjs from 'dayjs';

import { paths } from '@/config/paths';
import { createLogger } from '@/platform/logging/index';

import { BUILTIN_BASELINE } from './baseline';
import {
    compileRuleSet,
    evaluateRules,
    inputSubject,
    readDenyExcludeGlobs,
    type CompiledRuleSet,
    type PolicyContext,
    type PolicySnapshot
} from './rules';
import { getPermissionStore, type PermissionStore } from './store';

const log = createLogger('PermissionPolicy');

/**
 * 声明式权限策略引擎：团队基线（内置 / 外部整体替换）+ 用户规则（permissions.json v3 `rules`）。
 *
 * 不变量：
 * - 外部基线文件存在但损坏 → 所有工具降级为需确认，**不回落内置基线**（基线是团队安全承诺，不能静默变更）。
 * - 单条非法规则跳过并告警，不让整份规则失效，也不 fail-open。
 * - 外部基线按 mtime + size 缓存，文件变化无需重启即生效。
 */

interface BaselineState {
    rules: PermissionRuleSet;
    source: BaselineSource;
    error?: string;
}

interface BaselineCache extends BaselineState {
    key: string;
}

let baselineCache: BaselineCache | undefined;

function cloneRules(rules: Readonly<PermissionRuleSet>): PermissionRuleSet {
    return { deny: [...rules.deny], ask: [...rules.ask], allow: [...rules.allow] };
}

/** 外部基线文件内容校验：顶层对象，deny/ask/allow 可缺省但若存在必须是字符串数组。 */
function parseBaselineFile(raw: string): PermissionRuleSet {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是对象');
    const out: PermissionRuleSet = { deny: [], ask: [], allow: [] };
    for (const kind of ['deny', 'ask', 'allow'] as const) {
        const list = (parsed as Record<string, unknown>)[kind];
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.some((r) => typeof r !== 'string')) {
            throw new Error(`${kind} 必须是字符串数组`);
        }
        out[kind] = list as string[];
    }
    return out;
}

/** 读取团队基线：外部文件不存在 → 内置；存在且合法 → 外部整体替换；存在但损坏 → invalid。 */
export async function loadBaseline(): Promise<BaselineState> {
    const file = paths.policyFile();
    let key: string;
    try {
        const stat = await fsp.stat(file);
        key = `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.error('读取团队权限基线失败，所有工具降级为需确认', { file, err: error });
            return { rules: { deny: [], ask: [], allow: [] }, source: 'invalid', error: '基线文件无法读取' };
        }
        baselineCache = undefined;
        return { rules: cloneRules(BUILTIN_BASELINE), source: 'builtin' };
    }
    if (baselineCache?.key === key) return { ...baselineCache, rules: cloneRules(baselineCache.rules) };
    let state: BaselineState;
    try {
        state = { rules: parseBaselineFile(await fsp.readFile(file, 'utf8')), source: 'external' };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('团队权限基线文件损坏，所有工具降级为需确认', { file, err: message });
        state = { rules: { deny: [], ask: [], allow: [] }, source: 'invalid', error: `基线文件解析失败：${message}` };
    }
    baselineCache = { ...state, key };
    return { ...state, rules: cloneRules(state.rules) };
}

/** 一次性编译出的策略快照与视图信息。 */
interface PolicyState {
    snapshot: PolicySnapshot;
    baseline: BaselineState;
    user: PermissionRuleSet;
    invalid: string[];
}

export class PolicyEngine {
    constructor(private readonly store: Pick<PermissionStore, 'getRules'> = getPermissionStore()) {}

    private async state(): Promise<PolicyState> {
        const [baseline, user] = await Promise.all([loadBaseline(), this.store.getRules()]);
        const invalid: string[] = [];
        const compiledBaseline: CompiledRuleSet = compileRuleSet(baseline.rules, 'baseline', invalid);
        const compiledUser = compileRuleSet(user, 'user', invalid);
        if (invalid.length > 0) log.warn('跳过非法权限规则', { invalid });
        return {
            snapshot: {
                baseline: compiledBaseline,
                user: compiledUser,
                baselineInvalid: baseline.source === 'invalid'
            },
            baseline,
            user,
            invalid
        };
    }

    /** 按当前基线 + 用户规则判定一次工具调用；任何异常一律降级为需确认（fail-safe）。 */
    async evaluate(toolName: string, input: unknown, ctx: PolicyContext = {}): Promise<PolicyDecision> {
        try {
            const { snapshot } = await this.state();
            return evaluateRules(snapshot, toolName, input, ctx);
        } catch (error) {
            log.error('权限策略判定异常，降级为需确认', { toolName, err: error });
            return { decision: 'ask', rule: 'policy-error', source: 'floor', reason: '权限策略判定异常，需要确认' };
        }
    }

    /** 下推给 Grep 的 Read-deny 排除 glob（异常时返回空，不影响检索本身）。 */
    async grepExcludeGlobs(): Promise<string[]> {
        try {
            return readDenyExcludeGlobs((await this.state()).snapshot);
        } catch {
            return [];
        }
    }

    /** 设置页视图：基线（含来源）+ 用户规则 + 被跳过的非法规则。 */
    async view(): Promise<PolicyRulesView> {
        const { baseline, user, invalid } = await this.state();
        return {
            baseline: baseline.rules,
            baselineSource: baseline.source,
            baselinePath: paths.policyFile(),
            ...(baseline.error ? { baselineError: baseline.error } : {}),
            user,
            invalid
        };
    }
}

let engine: PolicyEngine | null = null;

export function getPolicyEngine(): PolicyEngine {
    if (!engine) engine = new PolicyEngine();
    return engine;
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/** 入参摘要截断长度（与 shell 审计的命令预览口径一致）。 */
const INPUT_PREVIEW_MAX = 300;

export interface PermissionAuditInput {
    sessionId?: string;
    toolName: string;
    input: unknown;
    decision: PolicyDecision;
}

let auditChain: Promise<void> = Promise.resolve();

/**
 * 追加写权限审计：只记 deny / ask / 按规则 allow，普通未命中不记（避免噪音）。
 * 只落判定对象（命令 / 路径 / URL）的截断摘要，不落文件正文等可能含敏感个人信息的字段；写失败只告警。
 */
export function recordPermissionAudit(entry: PermissionAuditInput): void {
    if (entry.decision.decision === 'none') return;
    const record = {
        ts: dayjs().toISOString(),
        sessionId: entry.sessionId,
        tool: entry.toolName,
        decision: entry.decision.decision,
        ruleId: entry.decision.rule,
        source: entry.decision.source,
        inputPreview: inputSubject(entry.toolName, entry.input).slice(0, INPUT_PREVIEW_MAX)
    };
    appendAuditRecord(record);
}

/** 记录审批分流结果，不写入命令、路径或工具参数。 */
export function recordApprovalDecision(entry: {
    sessionId?: string;
    tool: string;
    mode: ApprovalMode;
    source: string;
    decision: string;
}): void {
    appendAuditRecord({ ts: dayjs().toISOString(), ...entry });
}

function appendAuditRecord(record: object): void {
    const line = `${JSON.stringify(record)}\n`;
    auditChain = auditChain
        .then(async () => {
            await fsp.mkdir(paths.auditDir(), { recursive: true });
            await fsp.appendFile(paths.permissionAuditFile(), line, 'utf8');
        })
        .catch((error: unknown) => {
            log.warn('权限审计写入失败', { err: error });
        });
}

/** 测试用：等待审计队列落盘。 */
export function flushPermissionAudit(): Promise<void> {
    return auditChain;
}
