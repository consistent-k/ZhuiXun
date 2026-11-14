import {
    CheckCircleFilled,
    CloseCircleFilled,
    DownOutlined,
    UpOutlined,
    LoadingOutlined,
    SafetyOutlined,
    WarningFilled
} from '@ant-design/icons';
import { Button, Segmented, Tag, Typography } from 'antd';
import { useContext, useId, useMemo, useState, type ReactNode } from 'react';

import type { RememberScope } from '@/types/permission';
import { previewCommandHead } from '@/utils/commandHead';

import { dirnameOf, formatJson, lineCount, truncateSingleLine } from '../activity/format';
import { DiffView } from '../activity/presenters/DiffView';
import { toolDisplayLabel } from '../activity/registry';
import { ToolLabelContext } from '../tool-label-context';

import { assessApproval, RISK_LABEL, type ApprovalRiskLevel } from './risk';
import useStyles from './styles';

const { Text, Title } = Typography;

/** 审批批准时携带的「记住」意图；scope 为空表示只批准本次 */
export interface ApproveRemember {
    scope: RememberScope;
    /** 工具类型：Bash 记命令头，Write/Edit 记目录 */
    tool: 'Bash' | 'Write';
    /** Bash：原始命令 */
    command?: string;
    /** Write/Edit：目标文件绝对路径 */
    filePath?: string;
}

export interface ApprovalCardBodyProps {
    toolName: string;
    input?: unknown;
    approvalId: string;
    status: 'pending' | 'approved' | 'denied';
    isAutomatic?: boolean;
    requestReason?: string;
    denialReason?: string;
    /** full：带批准/拒绝按钮（dock）；none：只读上下文 + 去确认（内联卡） */
    actions?: 'full' | 'none';
    /** 是否仍可操作；历史轮次的 pending 只展示轨迹 */
    actionable?: boolean;
    submitting?: boolean;
    onApprove?: (approvalId: string, remember?: ApproveRemember) => void;
    onDeny?: (approvalId: string) => void;
    onLocate?: () => void;
    requestLink?: ReactNode;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
}

const RISK_COLOR: Record<ApprovalRiskLevel, string> = {
    low: 'default',
    medium: 'warning',
    high: 'error'
};

const SKIP_REASON_HINT: Record<string, string> = {
    compound: '包含 && / | / ; / 重定向等复合操作，出于安全无法记忆，仅可单次批准。',
    denylisted: '属于高危命令（如 rm / sudo / chmod），出于安全无法记忆，仅可单次批准。',
    unsafe: '命令形态无法安全解析，无法记忆，仅可单次批准。'
};

/**
 * 审批卡内容（内联只读版与底部 dock 操作版共用）。
 *
 * 内联卡不再放批准/拒绝按钮，避免两个操作面状态不一致；动作统一在 ApprovalDock。
 * 记住规则仍以后端为准：前端只做命令头/目录预览，Edit 复用 Write 的目录记忆。
 */
export function ApprovalCardBody({
    toolName,
    input,
    approvalId,
    status,
    isAutomatic = false,
    requestReason,
    denialReason,
    actions = 'none',
    actionable = true,
    submitting = false,
    onApprove,
    onDeny,
    onLocate,
    requestLink
}: ApprovalCardBodyProps) {
    const { styles, cx } = useStyles();
    const labels = useContext(ToolLabelContext);
    const [rememberScope, setRememberScope] = useState<'none' | RememberScope>('none');
    const [detailOpen, setDetailOpen] = useState(false);
    const detailsId = useId();

    const displayName = toolDisplayLabel(toolName, labels);
    const record = useMemo(() => asRecord(input), [input]);
    const command = useMemo(() => (toolName === 'Bash' ? readString(record, ['command']) : ''), [record, toolName]);
    const filePath = useMemo(
        () => (toolName === 'Write' || toolName === 'Edit' ? readString(record, ['file_path', 'path']) : ''),
        [record, toolName]
    );
    const headPreview = useMemo(() => (command ? previewCommandHead(command) : null), [command]);
    const writeDir = useMemo(() => (filePath ? dirnameOf(filePath) : ''), [filePath]);
    const canRemember = (toolName === 'Bash' && !!headPreview?.safe) || (!!filePath && !!writeDir);
    const assessment = useMemo(() => assessApproval(toolName, input, requestReason), [toolName, input, requestReason]);

    const handleApprove = () => {
        let remember: ApproveRemember | undefined;
        if (canRemember && rememberScope !== 'none') {
            remember =
                toolName === 'Bash'
                    ? { scope: rememberScope, tool: 'Bash', command }
                    : { scope: rememberScope, tool: 'Write', filePath };
        }
        onApprove?.(approvalId, remember);
    };

    if (actions === 'none' && status === 'pending' && !isAutomatic) {
        return (
            <div className={cx('approval-inline', styles.toString())} data-approval-id={approvalId}>
                <SafetyOutlined />
                <span>{actionable ? `${displayName} 待确认` : `${displayName} · 该轮已结束`}</span>
                {actionable && (
                    <Button type="link" size="small" onClick={onLocate}>
                        查看待确认操作
                    </Button>
                )}
            </div>
        );
    }

    const renderDetail = () => {
        if (toolName === 'Bash') {
            return command ? <pre className="approval-card-command-text">{command}</pre> : null;
        }
        if (toolName === 'Edit') {
            const oldText = readString(record, ['old_string']);
            const newText = readString(record, ['new_string']);
            return <DiffView oldText={oldText} newText={newText} />;
        }
        if (toolName === 'Write') {
            const content = readString(record, ['content']);
            if (!content) return filePath ? <div className="approval-card-path">{filePath}</div> : null;
            const lines = content.split('\n');
            const shown =
                lines.length > 40 ? `${lines.slice(0, 40).join('\n')}\n...（共 ${lines.length} 行）` : content;
            return <pre className="approval-card-command-text">{shown}</pre>;
        }
        if (toolName === 'create_skill' || toolName === 'update_skill') {
            const name = readString(record, ['name']);
            return name ? <div className="approval-card-path">技能：{name}</div> : null;
        }
        if (toolName === 'WebFetch') {
            const url = readString(record, ['url']);
            return url ? <div className="approval-card-path">{url}</div> : null;
        }
        return input == null ? null : <pre className="approval-card-command-text">{formatJson(input, 1200)}</pre>;
    };

    if (actions === 'full' && status === 'pending' && !isAutomatic) {
        const target = command || filePath || readString(record, ['url', 'name']) || assessment.scope;
        const detail = detailOpen ? renderDetail() : null;
        const rememberLabel = toolName === 'Bash' ? '记住此命令' : '记住此目录';

        return (
            <div
                className={cx('approval-card approval-card--compact', styles.toString())}
                data-approval-id={approvalId}
            >
                <div className="approval-card-bar">
                    <div className="approval-card-heading">
                        <SafetyOutlined className="approval-card-icon" />
                        <div className="approval-card-summary" role="status" aria-live="polite">
                            <span className="approval-card-summary-title">{displayName}待确认</span>
                            {target && (
                                <code className="approval-card-summary-target" title={target}>
                                    {target.replace(/\r?\n/g, ' ↵ ')}
                                </code>
                            )}
                        </div>
                    </div>
                    <div className="approval-card-buttons">
                        <Button
                            size="small"
                            type="text"
                            aria-expanded={detailOpen}
                            aria-controls={detailsId}
                            icon={detailOpen ? <UpOutlined /> : <DownOutlined />}
                            onClick={() => setDetailOpen((open) => !open)}
                        >
                            {detailOpen ? '收起' : '详情'}
                        </Button>
                        <Button
                            size="small"
                            type="text"
                            autoInsertSpace={false}
                            disabled={submitting}
                            onClick={() => onDeny?.(approvalId)}
                        >
                            拒绝
                        </Button>
                        <Button
                            size="small"
                            type="primary"
                            autoInsertSpace={false}
                            loading={submitting}
                            onClick={handleApprove}
                        >
                            {canRemember && rememberScope !== 'none' ? '批准并记住' : '批准'}
                        </Button>
                    </div>
                </div>
                <div id={detailsId} hidden={!detailOpen} className="approval-card-expanded">
                    {detailOpen && (
                        <>
                            <div className="approval-card-detail-header">
                                <Tag color={RISK_COLOR[assessment.level]} className="approval-card-tag">
                                    {RISK_LABEL[assessment.level]}
                                </Tag>
                                <span>{assessment.source}</span>
                                {requestLink}
                            </div>
                            {requestReason && (
                                <div className="approval-card-reason">
                                    <Text type="secondary">{requestReason}</Text>
                                </div>
                            )}
                            {filePath && (
                                <div className="approval-card-path">
                                    {filePath}
                                    {toolName === 'Write' && ` · ${lineCount(readString(record, ['content']))} 行`}
                                </div>
                            )}
                            {detail && <div className="approval-card-detail">{detail}</div>}
                            {canRemember ? (
                                <div className="approval-card-remember">
                                    <span className="approval-card-remember-label">{rememberLabel}</span>
                                    <Segmented
                                        size="small"
                                        aria-label={rememberLabel}
                                        value={rememberScope}
                                        onChange={(value) => setRememberScope(value as 'none' | RememberScope)}
                                        options={[
                                            { label: '不记住', value: 'none' },
                                            { label: '本次会话', value: 'session' },
                                            { label: '永久', value: 'permanent' }
                                        ]}
                                    />
                                    {rememberScope !== 'none' && (
                                        <span className="approval-card-remember-hint">
                                            {toolName === 'Bash' ? (
                                                <>
                                                    之后 <code>{headPreview?.head}</code> 开头的命令将免确认
                                                </>
                                            ) : (
                                                <>
                                                    之后写入 <code>{writeDir}</code> 目录将免确认
                                                </>
                                            )}
                                        </span>
                                    )}
                                </div>
                            ) : (
                                headPreview?.reason && (
                                    <span className="approval-card-remember-hint">
                                        {SKIP_REASON_HINT[headPreview.reason]}
                                    </span>
                                )
                            )}
                        </>
                    )}
                </div>
            </div>
        );
    }

    const detail = status !== 'pending' ? renderDetail() : null;

    return (
        <div className={cx('approval-card', styles.toString())} data-approval-id={approvalId}>
            <div className="approval-card-header">
                <SafetyOutlined className="approval-card-icon" />
                <Title level={5} className="approval-card-title">
                    {status === 'pending' ? `${displayName} 需要确认` : `${displayName} 审批记录`}
                </Title>
                {status === 'pending' && (
                    <Tag color={RISK_COLOR[assessment.level]} className="approval-card-tag">
                        {RISK_LABEL[assessment.level]}
                    </Tag>
                )}
                {status === 'pending' && (
                    <Tag variant="filled" className="approval-card-tag">
                        {assessment.source}
                    </Tag>
                )}
            </div>

            {requestReason && (
                <div className="approval-card-reason">
                    <Text type="secondary">{requestReason}</Text>
                </div>
            )}

            {assessment.scope && status === 'pending' && (toolName !== 'Bash' || actions === 'none') && (
                <div className="approval-card-scope">
                    <span className="approval-card-scope-label">影响范围</span>
                    <code className="approval-card-scope-value" title={assessment.scope}>
                        {truncateSingleLine(assessment.scope, 160)}
                    </code>
                </div>
            )}

            {detail &&
                (detailOpen ? (
                    <div className="approval-card-detail">{detail}</div>
                ) : (
                    <Button
                        type="link"
                        size="small"
                        className="approval-card-locate"
                        onClick={() => setDetailOpen(true)}
                    >
                        查看详情
                    </Button>
                ))}

            {toolName === 'Write' && filePath && (
                <div className="approval-card-meta">
                    <span>{lineCount(readString(record, ['content']))} 行</span>
                    <span className="approval-card-meta-path" title={filePath}>
                        {filePath}
                    </span>
                </div>
            )}

            {status === 'approved' && (
                <div className="approval-card-status">
                    <CheckCircleFilled className="approval-card-status-icon-success" />
                    <Text className="approval-card-status-text">{isAutomatic ? '自动批准' : '已批准'}</Text>
                </div>
            )}

            {status === 'denied' && (
                <div className="approval-card-status approval-card-status--denied">
                    {isAutomatic ? (
                        <WarningFilled className="approval-card-status-icon-error" />
                    ) : (
                        <CloseCircleFilled className="approval-card-status-icon-error" />
                    )}
                    <Text className="approval-card-status-text">
                        {isAutomatic ? '已被策略拒绝' : '已拒绝'}
                        {denialReason ? `：${denialReason}` : ''}
                    </Text>
                </div>
            )}

            {status === 'pending' && isAutomatic && (
                <div className="approval-card-status">
                    <LoadingOutlined className="approval-card-status-icon-pending" />
                    <Text className="approval-card-status-text">自动处理中...</Text>
                </div>
            )}
        </div>
    );
}

export default ApprovalCardBody;
