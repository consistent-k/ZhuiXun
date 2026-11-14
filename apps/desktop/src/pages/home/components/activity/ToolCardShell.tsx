import {
    CheckCircleFilled,
    CloseCircleFilled,
    DownOutlined,
    LoadingOutlined,
    SafetyOutlined,
    StopOutlined,
    WarningFilled
} from '@ant-design/icons';
import { Tag } from 'antd';
import { memo, useEffect, useState } from 'react';

import { bashExitCode, isSoftFailure, readOutput, type ToolItem, type ToolRunStatus } from './model';
import type { ToolPresentation } from './presentation';
import useStyles from './ToolCardShell/styles';

interface StatusView {
    icon: React.ReactNode;
    text: string;
}

function statusView(item: ToolItem): StatusView {
    const status: ToolRunStatus = item.status;
    switch (status) {
        case 'preparing':
            return { icon: <LoadingOutlined />, text: '准备中' };
        case 'waiting-approval':
            return { icon: <SafetyOutlined />, text: '待确认' };
        case 'running':
            return { icon: <LoadingOutlined />, text: '执行中' };
        case 'warning': {
            const output = readOutput(item);
            if (item.toolName === 'Bash') {
                const exitCode = bashExitCode(output);
                if (exitCode != null) return { icon: <WarningFilled />, text: `退出码 ${exitCode}` };
            }
            return { icon: <WarningFilled />, text: isSoftFailure(output) ? '未生效' : '需注意' };
        }
        case 'error':
            return { icon: <CloseCircleFilled />, text: '失败' };
        case 'denied':
            return { icon: <StopOutlined />, text: '已拒绝' };
        case 'canceled':
            return { icon: <StopOutlined />, text: '已取消' };
        default:
            return { icon: <CheckCircleFilled />, text: '完成' };
    }
}

export interface ToolCardShellProps {
    item: ToolItem;
    presentation: ToolPresentation;
}

/**
 * 工具卡统一骨架：摘要行 + 懒详情。
 *
 * - 收起态只渲染摘要，不解析 input/output、不挂高亮；
 * - `Body` 存在才可展开；错误/拒绝态由 `autoOpen=attention` 自动展开一次；
 * - 卡片整体 memo，流式中非活动工具卡不随 token 重渲染。
 */
export const ToolCardShell = memo(function ToolCardShell({ item, presentation }: ToolCardShellProps) {
    const { styles, cx } = useStyles();
    const [expanded, setExpanded] = useState(false);
    const canToggle = Boolean(presentation.Body);
    const attention = item.status === 'error' || item.status === 'denied' || item.status === 'warning';

    useEffect(() => {
        if (presentation.autoOpen === 'attention' && attention) setExpanded(true);
    }, [attention, presentation.autoOpen]);

    const status = statusView(item);
    const Body = presentation.Body;

    return (
        <div className={cx('tool-card', `is-${item.status}`, styles.toString())} data-tool-call-id={item.toolCallId}>
            <button
                type="button"
                className="tool-card-header"
                disabled={!canToggle}
                aria-expanded={canToggle ? expanded : undefined}
                onClick={() => {
                    if (canToggle) setExpanded((value) => !value);
                }}
            >
                <span className="tool-card-icon">{presentation.icon}</span>
                <span className="tool-card-kind">{presentation.kindLabel}</span>
                <span
                    className="tool-card-primary"
                    title={typeof presentation.primary === 'string' ? presentation.primary : undefined}
                >
                    {presentation.primary}
                </span>
                {presentation.secondary && (
                    <span
                        className="tool-card-secondary"
                        title={typeof presentation.secondary === 'string' ? presentation.secondary : undefined}
                    >
                        {presentation.secondary}
                    </span>
                )}
                {presentation.sourceLabel && (
                    <Tag variant="filled" className="tool-card-source">
                        {presentation.sourceLabel}
                    </Tag>
                )}
                {item.autoApproved && (
                    <Tag variant="filled" className="tool-card-source">
                        自动放行
                    </Tag>
                )}
                <span className={cx('tool-card-status', `tool-card-status--${item.status}`)}>
                    {status.icon} {status.text}
                </span>
                {canToggle && <DownOutlined className={cx('tool-card-chevron', expanded && 'is-expanded')} />}
            </button>
            {canToggle && expanded && Body && (
                <div className="tool-card-body">
                    <Body item={item} />
                </div>
            )}
        </div>
    );
});

export default ToolCardShell;
