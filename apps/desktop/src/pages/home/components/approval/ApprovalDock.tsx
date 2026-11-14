import { QuestionCircleOutlined, SafetyOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { toolDisplayLabel } from '../activity/registry';
import { useChatActions, useChatMessages } from '../chat-context';
import { ToolLabelContext } from '../tool-label-context';

import { ApprovalCardBody, type ApproveRemember } from './ApprovalCardBody';
import useStyles from './ApprovalDock/styles';
import { LOCATE_APPROVAL_EVENT, LOCATE_QUESTION_EVENT, locateQuestion } from './locate';
import type { PendingInteraction } from './pending';
import { usePendingInteractions } from './usePendingInteractions';

/**
 * 待确认 dock：输入框上方的唯一操作面。
 *
 * - 审批与提问都从当前轮消息派生，不新增 store；
 * - 多个待确认项按 FIFO 展示，处理完自动切到下一个；
 * - Enter 批准 / Esc 拒绝只在本 dock 内、非输入控件、非 IME 组合时生效。
 */
export function ApprovalDock() {
    const { styles, cx } = useStyles();
    const messages = useChatMessages();
    const actions = useChatActions();
    const labels = useContext(ToolLabelContext);
    const items = usePendingInteractions(messages);
    const [activeKey, setActiveKey] = useState<string | null>(null);
    // 记录「哪个审批正在提交」而不是布尔值：切换队列项时天然恢复可点，不需要 effect 重置状态
    const [submittingFor, setSubmittingFor] = useState<string | null>(null);
    const [queueOpen, setQueueOpen] = useState(false);
    const dockRef = useRef<HTMLElement>(null);
    // 事件监听只注册一次；用 ref 读最新的待确认项，避免流式期间每 50ms 重挂 window 监听
    const itemsRef = useRef(items);
    useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    const active: PendingInteraction | undefined = useMemo(
        () => items.find((item) => item.key === activeKey) ?? items[0],
        [activeKey, items]
    );
    const activeIndex = active ? items.findIndex((item) => item.key === active.key) : -1;
    const submitting = active?.approvalId != null && submittingFor === active.approvalId;

    useEffect(() => {
        const onLocate = (event: Event) => {
            const detail = (event as CustomEvent<{ approvalId?: string; toolCallId?: string }>).detail;
            if (detail?.approvalId) {
                const found = itemsRef.current.find((item) => item.approvalId === detail.approvalId);
                if (found) {
                    setActiveKey(found.key);
                    setQueueOpen(false);
                    dockRef.current?.scrollIntoView({ block: 'nearest' });
                    dockRef.current?.focus();
                }
            }
            if (detail?.toolCallId) {
                const selector = `[data-question-anchor="${CSS.escape(detail.toolCallId)}"]`;
                document.querySelector(selector)?.scrollIntoView({ block: 'center' });
            }
        };
        window.addEventListener(LOCATE_APPROVAL_EVENT, onLocate);
        window.addEventListener(LOCATE_QUESTION_EVENT, onLocate);
        return () => {
            window.removeEventListener(LOCATE_APPROVAL_EVENT, onLocate);
            window.removeEventListener(LOCATE_QUESTION_EVENT, onLocate);
        };
    }, []);

    const handleApprove = useCallback(
        (approvalId: string, remember?: ApproveRemember) => {
            setSubmittingFor(approvalId);
            actions.approveTool(approvalId, remember);
            window.setTimeout(() => setSubmittingFor((current) => (current === approvalId ? null : current)), 3000);
        },
        [actions]
    );

    const handleDeny = useCallback(
        (approvalId: string) => {
            setSubmittingFor(approvalId);
            actions.denyTool(approvalId);
            window.setTimeout(() => setSubmittingFor((current) => (current === approvalId ? null : current)), 3000);
        },
        [actions]
    );

    const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (!active || active.kind !== 'approval' || submitting) return;
        if (!event.currentTarget.contains(document.activeElement)) return;
        const target = event.target as Element;
        if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        if (event.key === 'Enter' && target.closest('button, a[href], [role="button"]')) return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        // keyCode=229 补充 isComposing 未覆盖的输入法确认事件，避免组词时误触发审批快捷键。
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (event.key === 'Enter') {
            if (active.approvalId) handleApprove(active.approvalId);
        } else if (active.approvalId) {
            handleDeny(active.approvalId);
        }
    };

    if (!active) return null;

    const request = messages.findLast((message) => message.role === 'user');
    const requestAnchor = request ? `chat-request-${request.id}` : undefined;

    return (
        <section
            ref={dockRef}
            id="approval-dock"
            tabIndex={-1}
            role="region"
            aria-label="待确认操作"
            className={cx('approval-dock', active.kind === 'question' && 'approval-dock--question', styles.toString())}
            onKeyDown={handleKeyDown}
        >
            {items.length > 1 && (
                <div className="approval-dock-header">
                    <span className="approval-dock-count" role="status" aria-live="polite">
                        待确认 {activeIndex + 1} / {items.length}
                    </span>
                    <Button
                        type="text"
                        size="small"
                        aria-expanded={queueOpen}
                        onClick={() => setQueueOpen((value) => !value)}
                    >
                        {queueOpen ? '收起列表' : '查看待确认列表'}
                    </Button>
                </div>
            )}

            {queueOpen && items.length > 1 && (
                <ul className="approval-dock-queue">
                    {items.map((item) => (
                        <li key={item.key}>
                            <button
                                type="button"
                                className={cx('approval-dock-queue-item', item.key === active.key && 'is-active')}
                                onClick={() => setActiveKey(item.key)}
                            >
                                {item.kind === 'approval' ? <SafetyOutlined /> : <QuestionCircleOutlined />}
                                <span>
                                    {item.kind === 'approval'
                                        ? `${toolDisplayLabel(item.toolName, labels)} 待确认`
                                        : '一组问题待回答'}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {active.kind === 'approval' && active.approvalId ? (
                <ApprovalCardBody
                    key={active.key}
                    toolName={active.toolName}
                    input={'input' in active.part ? active.part.input : undefined}
                    approvalId={active.approvalId}
                    status="pending"
                    requestReason={'approval' in active.part ? active.part.approval?.requestReason : undefined}
                    actions="full"
                    submitting={submitting}
                    onApprove={handleApprove}
                    onDeny={handleDeny}
                    requestLink={
                        requestAnchor && (
                            <Button
                                className="approval-card-request-link"
                                type="link"
                                size="small"
                                onClick={() => {
                                    const target = document.getElementById(requestAnchor);
                                    target?.scrollIntoView({ block: 'nearest' });
                                    target?.focus({ preventScroll: true });
                                }}
                            >
                                查看原始请求
                            </Button>
                        )
                    }
                />
            ) : (
                <div className="approval-dock-question">
                    <QuestionCircleOutlined />
                    <span>模型有一组问题待回答</span>
                    <Button type="link" onClick={() => locateQuestion(active.toolCallId)}>
                        去回答
                    </Button>
                </div>
            )}
        </section>
    );
}

export default ApprovalDock;
