import { CloseOutlined } from '@ant-design/icons';
import type { WorkspaceFileReference, WorkspaceSummary } from '@zhuixun/shared';
import { Alert, Button, Tabs } from 'antd';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useChatStore } from '@/stores';
import { useConversationPanel, useWorkspacePanelStore, useWorkspaceSummaries } from '@/stores/workspacePanelStore';

import { beginFileOpen } from './file-opening';
import { FileTurnContext } from './file-reference';
import { FilePreview } from './FilePreview';
import { FileReference } from './FileReference';
import useStyles from './styles';

/** 与 ChatSession 的流式 Context 分离，只订阅工作区结构化状态。 */
export function ChatWorkspace({ children }: { children: ReactNode }) {
    const { styles, cx } = useStyles();
    const id = useChatStore((s) => s.currentConversationId) ?? '';
    const panel = useConversationPanel(id);
    const summaries = useWorkspaceSummaries(id);
    const width = useWorkspacePanelStore((s) => s.width);
    const identityError = useWorkspacePanelStore((s) => s.identityError);
    const instance = useWorkspacePanelStore((s) => s.instance);
    const container = useRef<HTMLDivElement>(null);
    const [available, setAvailable] = useState(0);
    const dragCleanup = useRef<(() => void) | undefined>(undefined);
    // 文件始终内嵌；扣除分隔线后为聊天保留 320px，极窄窗口由容器横向滚动。
    const maxWidth = Math.max(280, Math.min(720, available - 325));
    const actualWidth = Math.max(280, Math.min(width, maxWidth));
    useEffect(() => {
        const element = container.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
        observer.observe(element);
        return () => {
            observer.disconnect();
            dragCleanup.current?.();
        };
    }, []);
    useEffect(() => {
        void useWorkspacePanelStore.getState().initialize();
    }, []);
    useEffect(() => {
        if (id && instance) void useWorkspacePanelStore.getState().load(id);
    }, [id, instance]);
    const hasSummary = summaries.some(
        (summary) => summary.tasks.length > 0 || summary.sources.length > 0 || summary.artifacts.length > 0
    );
    // 按用户当前窗口适配：工作区达到 1140px 即展示，并为摘要预留右侧空间。
    const previewOpen = panel.open && panel.tabs.some((tab) => tab.id === panel.active);
    const showSummary = hasSummary && !previewOpen && available >= 1140;
    const close = () => {
        beginFileOpen(id);
        useWorkspacePanelStore.getState().change(id, (p) => ({ ...p, open: false }));
    };
    const panelContent = <PanelContents id={id} />;
    return (
        <div
            className={cx(
                'chat-workspace',
                { 'chat-workspace-preview-open': previewOpen, 'chat-workspace-summary-visible': showSummary },
                styles.toString()
            )}
            ref={container}
        >
            <div className="chat-workspace-chat">
                {identityError && (
                    <Alert
                        type="warning"
                        title={identityError}
                        action={
                            <Button onClick={() => void useWorkspacePanelStore.getState().initialize()}>重试</Button>
                        }
                    />
                )}
                {children}
            </div>
            {previewOpen && (
                <>
                    <div
                        className="workspace-divider"
                        role="separator"
                        aria-label="调整文件预览宽度"
                        aria-orientation="vertical"
                        aria-valuenow={actualWidth}
                        aria-valuemin={280}
                        aria-valuemax={maxWidth}
                        tabIndex={0}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                                event.preventDefault();
                                useWorkspacePanelStore
                                    .getState()
                                    .setWidth(Math.min(maxWidth, actualWidth + (event.key === 'ArrowLeft' ? 20 : -20)));
                            }
                        }}
                        onPointerDown={(event) => {
                            const origin = event.clientX;
                            const move = (pointer: PointerEvent) =>
                                useWorkspacePanelStore
                                    .getState()
                                    .setWidth(Math.min(maxWidth, actualWidth + origin - pointer.clientX));
                            const end = () => {
                                window.removeEventListener('pointermove', move);
                                window.removeEventListener('pointerup', end);
                            };
                            dragCleanup.current?.();
                            dragCleanup.current = end;
                            window.addEventListener('pointermove', move);
                            window.addEventListener('pointerup', end, { once: true });
                        }}
                    />
                    <aside className="workspace-panel" style={{ width: actualWidth }} aria-label="文件预览">
                        <Button
                            className="workspace-close"
                            type="text"
                            icon={<CloseOutlined />}
                            aria-label="收起文件预览"
                            onClick={close}
                        />
                        {panelContent}
                    </aside>
                </>
            )}
            {showSummary && (
                <aside className="workspace-summary-float" aria-label="会话摘要">
                    <SummaryView key={id} id={id} />
                </aside>
            )}
        </div>
    );
}

function PanelContents({ id }: { id: string }) {
    const panel = useConversationPanel(id);
    const summaries = useWorkspaceSummaries(id);
    const active = panel.tabs.find((tab) => tab.id === panel.active);
    const changed =
        active?.reference.kind === 'workspace'
            ? summaries
                  .filter((s) =>
                      s.changedPaths.includes(active.reference.kind === 'workspace' ? active.reference.path : '')
                  )
                  .map(
                      (s) =>
                          `${s.turnId}:${s.changedPaths.filter((file) => active.reference.kind === 'workspace' && file === active.reference.path).length}`
                  )
                  .join('|')
            : '';
    const dragged = useRef('');
    return (
        <>
            <Tabs
                type="editable-card"
                hideAdd
                activeKey={panel.active}
                onChange={(key) => useWorkspacePanelStore.getState().change(id, (p) => ({ ...p, active: key }))}
                onEdit={(key, action) => {
                    if (action === 'remove' && typeof key === 'string')
                        useWorkspacePanelStore.getState().closeFile(id, key);
                }}
                items={[
                    ...panel.tabs.map((tab) => ({
                        key: tab.id,
                        label: (
                            <span
                                draggable
                                onDragStart={() => {
                                    dragged.current = tab.id;
                                }}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={() =>
                                    useWorkspacePanelStore.getState().change(id, (p) => {
                                        const from = p.tabs.find((t) => t.id === dragged.current);
                                        if (!from || from.id === tab.id) return p;
                                        const tabs = p.tabs.filter((t) => t.id !== from.id);
                                        tabs.splice(
                                            tabs.findIndex((t) => t.id === tab.id),
                                            0,
                                            from
                                        );
                                        return { ...p, tabs };
                                    })
                                }
                            >
                                {tab.reference.name}
                            </span>
                        ),
                        closable: true
                    }))
                ]}
            />
            <div className="workspace-active-content">
                {active ? (
                    <Alert.ErrorBoundary key={active.id}>
                        <FileTurnContext.Provider value={active.reference.turnId}>
                            <FilePreview id={id} tab={active} changed={changed} />
                        </FileTurnContext.Provider>
                    </Alert.ErrorBoundary>
                ) : null}
            </div>
        </>
    );
}
function fileKey(file: WorkspaceFileReference): string {
    return file.kind === 'workspace' ? `workspace:${file.path}` : `attachment:${file.attachmentId}`;
}

const statusLabels = { running: '进行中', waiting: '等待确认', completed: '已结束', stopped: '已停止', failed: '失败' };
function SummaryView({ id }: { id: string }) {
    const summaries = useWorkspaceSummaries(id);
    const error = useWorkspacePanelStore((state) => state.summaryErrors[id]);
    const summary = useMemo(() => {
        if (!summaries.length) return;
        const tasks = new Map<string, WorkspaceSummary['tasks'][number]>();
        const sources = new Map<string, WorkspaceSummary['sources'][number]>();
        const artifacts = new Map<string, WorkspaceFileReference>();
        // 按轮次顺序覆盖，保留任务最新状态及文件最近一次有效引用。
        for (const turn of summaries) {
            for (const task of turn.tasks) tasks.set(task.id, task);
            for (const source of turn.sources)
                sources.set(source.file ? fileKey(source.file) : (source.url ?? source.id), source);
            for (const file of turn.artifacts) artifacts.set(fileKey(file), file);
        }
        return {
            status: summaries.at(-1)!.status,
            tasks: [...tasks.values()],
            sources: [...sources.values()],
            artifacts: [...artifacts.values()]
        };
    }, [summaries]);
    if (error)
        return (
            <Alert
                type="error"
                title="摘要加载失败"
                description={error}
                action={<Button onClick={() => void useWorkspacePanelStore.getState().load(id)}>重试</Button>}
            />
        );
    if (!summary)
        return (
            <div className="workspace-empty">
                <h3>会话工作区</h3>
                <p>任务、参考来源和交付文件会汇集在这里。</p>
            </div>
        );
    return (
        <div className="workspace-summary">
            <div className="workspace-summary-top">
                <span>{statusLabels[summary.status]}</span>
            </div>
            {summary.tasks.length > 0 && (
                <section>
                    <h3>
                        任务{' '}
                        <small>
                            {summary.tasks.filter((t) => t.status === 'completed').length}/{summary.tasks.length}
                        </small>
                    </h3>
                    <ul>
                        {summary.tasks.map((task) => (
                            <li key={task.id} className={`workspace-task-${task.status}`}>
                                <span>
                                    {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◉' : '○'}
                                </span>{' '}
                                {task.status === 'in_progress' ? (task.activeForm ?? task.subject) : task.subject}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {summary.sources.length > 0 && (
                <section>
                    <h3>
                        来源 <small>{summary.sources.length}</small>
                    </h3>
                    <ul>
                        {summary.sources.map((source) => (
                            <li key={source.file ? fileKey(source.file) : (source.url ?? source.id)}>
                                {source.file ? (
                                    <FileReference reference={source.file} />
                                ) : (
                                    source.url && (
                                        <a href={source.url} target="_blank" rel="noreferrer">
                                            {source.name}
                                        </a>
                                    )
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            <section>
                <h3>
                    交付产物 <small>{summary.artifacts.length}</small>
                </h3>
                <ul>
                    {summary.artifacts.map((file) => (
                        <li key={file.kind === 'workspace' ? file.path : file.attachmentId}>
                            <FileReference reference={file} />
                        </li>
                    ))}
                </ul>
                {!summary.artifacts.length && <p className="workspace-muted">完成的交付文件将在登记后显示</p>}
            </section>
        </div>
    );
}
