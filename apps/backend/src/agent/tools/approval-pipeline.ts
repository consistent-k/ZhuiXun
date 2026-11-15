import type { ApprovalMode } from '@zhuixun/shared';
import type { ModelMessage, ToolApprovalStatus } from 'ai';

import type { HookVerdict, ToolHookRunner } from './hook-wrapper';

/**
 * 工具审批管线：声明式策略 + PreToolUse hooks + 既有 broker，产出 AI SDK 的 generic 审批函数。
 *
 * 判定顺序（取第一个命中）：
 * 1. 策略 deny → denied（危险模式下仍拒绝）
 * 2. PreToolUse deny / 退出码 2 → denied
 * 3. 策略 ask、hook ask、hook 故障 → 危险模式 approved；有确认 UI 则 user-approval；无 UI 则 denied
 * 4. hook allow 或策略 allow → approved（Write/Edit 目标在系统目录时仍按第 3 步需确认）
 * 5. 其余交给 fallback（既有 broker：Bash/Write/Edit 记忆与信任项目等；其它工具 not-applicable）；
 *    无 UI 场景下 fallback 的 user-approval 一律转 denied。
 *
 * 只依赖端口（策略函数 / hook runner / fallback），不 import modules，满足 agent 层边界。
 */

/** 策略端口的判定结果（与 shared 的 PolicyDecision 结构兼容）。 */
export interface PolicyVerdict {
    decision: 'deny' | 'ask' | 'allow' | 'none';
    reason?: string;
    requiresHuman?: boolean;
}

export interface ApprovalPipelineOptions {
    /** 声明式策略；缺省视为全部 none。 */
    policy?: (toolName: string, input: unknown) => Promise<PolicyVerdict>;
    /** PreToolUse hooks；缺省或无匹配时跳过。 */
    hooks?: Pick<ToolHookRunner, 'matches' | 'pre'>;
    /** 未被策略 / hook 决定时的既有审批。 */
    fallback: (toolName: string, input: unknown) => ToolApprovalStatus | Promise<ToolApprovalStatus>;
    /** Write/Edit 目标是否落在系统目录（allow 只免确认，不越过系统目录保护）。 */
    writeDenylisted?: (toolName: string, input: unknown) => boolean;
    /** 是否有确认 UI（主对话有；子 agent、IM 渠道没有）。 */
    hasUi: boolean;
    /** 危险跳过审批模式（服务端启动态）。 */
    danger: boolean;
    mode?: ApprovalMode;
    review?: (call: ApprovalToolCall) => Promise<boolean>;
    reviewAction?: (call: ApprovalToolCall, messages?: ModelMessage[]) => Promise<ToolApprovalStatus>;
    onDecision?: (call: ApprovalToolCall, source: string, status: ToolApprovalStatus) => void;
    /** 不参与策略 / hook 的工具（如 client 交互工具，审批会让它无法工作）。 */
    exempt?: ReadonlySet<string>;
}

export interface ApprovalToolCall {
    toolName: string;
    toolCallId?: string;
    input: unknown;
}

export type ToolApprovalFn = (options: {
    toolCall: ApprovalToolCall;
    messages?: ModelMessage[];
}) => Promise<ToolApprovalStatus>;

const NO_UI_SUFFIX = '（当前场景没有确认界面，已自动拒绝）';

function statusType(status: ToolApprovalStatus): string {
    if (status === undefined) return 'not-applicable';
    return typeof status === 'string' ? status : status.type;
}

export function createApprovalPipeline(opts: ApprovalPipelineOptions): ToolApprovalFn {
    const fullAccess = opts.hasUi && opts.mode === 'full-access';
    const ask = (reason: string, requiresHuman = false): ToolApprovalStatus => {
        if (opts.danger || (fullAccess && !requiresHuman)) return { type: 'approved', reason };
        if (opts.hasUi) return { type: 'user-approval', reason };
        return { type: 'denied', reason: `${reason}${NO_UI_SUFFIX}` };
    };

    const runHooks = async (toolName: string, input: unknown): Promise<HookVerdict> => {
        if (!opts.hooks?.matches('PreToolUse', toolName)) return { decision: 'none' };
        try {
            return await opts.hooks.pre({ toolName, input });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { decision: 'ask', failed: true, reason: `PreToolUse hook 执行失败：${message}` };
        }
    };

    const decide = async (call: ApprovalToolCall, messages?: ModelMessage[]): Promise<ToolApprovalStatus> => {
        const { toolName, input } = call;
        const report = (source: string, status: ToolApprovalStatus) => {
            opts.onDecision?.(call, source, status);
            return status;
        };
        if (opts.exempt?.has(toolName)) return opts.fallback(toolName, input);

        const policy = (await opts.policy?.(toolName, input)) ?? { decision: 'none' };
        if (policy.decision === 'deny') return report('policy', { type: 'denied', reason: policy.reason });

        const hook = await runHooks(toolName, input);
        if (hook.decision === 'deny') {
            return report('hook', {
                type: 'denied',
                reason: hook.reason ? `PreToolUse hook 拒绝：${hook.reason}` : 'PreToolUse hook 拒绝'
            });
        }
        // 完全访问只跳过常规审批。系统目录和判定故障仍需用户确认。
        if (fullAccess && opts.writeDenylisted?.(toolName, input)) {
            return report('system-directory', ask('写入目标位于系统目录，需要确认', true));
        }
        if (policy.decision === 'ask') {
            return report(
                'policy',
                ask(policy.reason ?? '命中权限规则，需要确认', policy.requiresHuman || hook.failed)
            );
        }
        if (hook.decision === 'ask') {
            return report(
                'hook',
                ask(
                    hook.failed ? `${hook.reason}，需要确认` : `PreToolUse hook 要求确认：${hook.reason ?? ''}`,
                    hook.failed
                )
            );
        }
        if (hook.decision === 'allow' || policy.decision === 'allow') {
            if (opts.writeDenylisted?.(toolName, input)) return ask('写入目标位于系统目录，需要确认');
            return { type: 'approved', reason: hook.decision === 'allow' ? 'PreToolUse hook 放行' : policy.reason };
        }

        const status = await opts.fallback(toolName, input);
        if (statusType(status) === 'user-approval' && opts.hasUi) {
            if (fullAccess) return report('broker', ask('本轮已授权完全访问'));
            if (opts.mode === 'auto-review' && (await opts.review?.(call))) {
                return report('project-edit-review', { type: 'approved', reason: '目标为已核验的可信项目内文件' });
            }
            if (opts.mode === 'auto-review' && !opts.writeDenylisted?.(toolName, input)) {
                const decision = await opts.reviewAction?.(call, messages);
                if (decision && statusType(decision) !== 'not-applicable') return report('action-review', decision);
            }
            return report('broker', status);
        }
        if (!opts.hasUi && statusType(status) === 'user-approval') {
            return { type: 'denied', reason: `该操作需要用户确认${NO_UI_SUFFIX}` };
        }
        return status;
    };

    return async ({ toolCall, messages }) => {
        try {
            return await decide(toolCall, messages);
        } catch (error) {
            // 任何判定异常都不 fail-open：有 UI 时交给用户确认，否则拒绝
            const message = error instanceof Error ? error.message : String(error);
            return opts.hasUi && !opts.danger
                ? { type: 'user-approval', reason: `审批判定异常（${message}），需要确认` }
                : { type: 'denied', reason: `审批判定异常（${message}）` };
        }
    };
}
