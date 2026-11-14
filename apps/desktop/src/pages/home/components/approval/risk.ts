import { previewCommandHead } from '@/utils/commandHead';

import { dirnameOf, hostOf, parseMcpName, truncateSingleLine } from '../activity/format';

export type ApprovalRiskLevel = 'low' | 'medium' | 'high';

export interface ApprovalAssessment {
    level: ApprovalRiskLevel;
    /** 审批来源：权限策略 / Hook / 系统保护 / 已记忆规则 */
    source: string;
    /** 影响范围：命令头、目录、URL 域名、技能名等 */
    scope?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function sourceOf(reason: string | undefined): string {
    const text = reason ?? '';
    if (/PreToolUse hook|hook/i.test(text)) return 'Hook';
    if (/团队基线|策略|规则/.test(text)) return '权限策略';
    if (/系统目录|受保护|升权敏感/.test(text)) return '系统保护';
    if (/信任项目|记忆/.test(text)) return '已记忆规则';
    return '权限规则';
}

function isSensitivePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return /(^|\/)(\.git|\.ssh|\.zhuixun|etc|usr|bin|sbin|System|Library|Windows|Program Files)(\/|$)/i.test(
        normalized
    );
}

/**
 * 审批风险与来源评估（仅前端提示，不放行/拒绝任何操作）。
 *
 * 来源目前只能从后端 `requestReason` 文案归类；P3 若补结构化 descriptor，这里整体替换即可。
 */
export function assessApproval(toolName: string, input: unknown, requestReason?: string): ApprovalAssessment {
    const record = asRecord(input);
    const source = sourceOf(requestReason);

    if (toolName === 'Bash') {
        const command = readString(record, ['command']);
        const head = previewCommandHead(command);
        const level: ApprovalRiskLevel =
            head.reason === 'denylisted' ? 'high' : head.reason === 'compound' ? 'medium' : 'low';
        return { level, source, scope: head.head ?? truncateSingleLine(command, 80) };
    }

    if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = readString(record, ['file_path', 'path']);
        return {
            level: isSensitivePath(filePath) ? 'high' : 'medium',
            source,
            scope: dirnameOf(filePath) || filePath
        };
    }

    if (toolName === 'create_skill' || toolName === 'update_skill') {
        return { level: 'high', source, scope: readString(record, ['name']) };
    }

    if (toolName === 'WebFetch') {
        const url = readString(record, ['url']);
        return { level: 'low', source, scope: url ? hostOf(url) : undefined };
    }

    const mcp = parseMcpName(toolName);
    if (mcp) return { level: 'medium', source, scope: mcp.server };

    return { level: 'medium', source };
}

export const RISK_LABEL: Record<ApprovalRiskLevel, string> = {
    low: '低风险',
    medium: '需注意',
    high: '高风险'
};
