import {
    PlusOutlined,
    SearchOutlined,
    SettingOutlined,
    DeleteOutlined,
    ApiOutlined,
    ClockCircleOutlined,
    ClearOutlined,
    FolderOutlined,
    FolderAddOutlined,
    EditOutlined,
    InboxOutlined,
    LoadingOutlined,
    MessageOutlined,
    SwapOutlined,
    ExportOutlined,
    ImportOutlined,
    MoreOutlined,
    SafetyOutlined,
    ExclamationCircleOutlined,
    DownloadOutlined,
    EllipsisOutlined
} from '@ant-design/icons';
import { Conversations } from '@ant-design/x';
import { App, Button, Collapse, Dropdown, Form, Input, Popconfirm, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import type { ReactNode } from 'react';
import { useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import Modal from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { useStreamingConversations } from '@/hooks';
import { collectPendingInteractions } from '@/pages/home/components/approval/pending';
import {
    exportConversationsApi,
    fetchConversationApi,
    importConversationsApi,
    type SavedConversation
} from '@/services';
import { useAutomationStore, useChatStore } from '@/stores';
import { colors } from '@/theme/tokens';
import dayjs from '@/utils/dayjs';

import useStyles from './styles';

interface ConversationOriginLite {
    kind: 'channel';
    channelId: string;
    channelName?: string;
    imUserId: string;
}

interface ConversationLite {
    id: string;
    title: string;
    updatedAt: number;
    projectId?: string;
    origin?: ConversationOriginLite;
}

interface ProjectLite {
    id: string;
    name: string;
}

/** 未分组桶的固定 key（不与真实项目 id 冲突：id 是 uuid） */
const UNGROUPED = '__ungrouped__';

interface SidebarProps {
    conversations: ConversationLite[];
    projects: ProjectLite[];
    currentConversationId: string | null;
    onSelectConversation: (convId: string) => void;
    /** 在当前选中项目下新建对话（草稿态） */
    onNewConversation: () => void;
    onNewConversationInProject: (projectId: string | null) => void;
    onCreateProject: () => void;
    onOpenProjectSettings: (projectId: string) => void;
    onDeleteProject: (projectId: string) => void;
    onMoveConversation: (convId: string, projectId: string | null) => void;
    /** 重命名会话 */
    onRenameConversation?: (convId: string, title: string) => void;
    onDeleteConversation?: (convId: string) => void;
    onClearAll?: () => void;
    /** 导入会话成功后触发（刷新列表） */
    onConversationsChanged?: () => void;
}

/** 触发浏览器下载一个 JSON 文件 */
function downloadJson(filename: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function formatTime(timestamp: number): string {
    const d = dayjs(timestamp);
    // 一周内用相对时间（刚刚 / x 分钟前 …），更久则落到绝对日期
    if (dayjs().diff(d, 'day') >= 7) return d.format('YYYY/MM/DD');
    return d.locale('zh-cn').fromNow();
}

function BrandMark() {
    return <img className="sidebar-brand-mark" src="/favicon.svg" alt="" />;
}

/** WorkBuddy 风格的主导航行：图标 + 文案，可选 BETA 标签 / 右侧提示 / 选中态 */
function NavRow({
    icon,
    label,
    onClick,
    tag,
    hint,
    badge,
    accent,
    active
}: {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    tag?: string;
    hint?: string;
    /** 未读计数角标（如定时任务完成数） */
    badge?: number;
    accent?: boolean;
    active?: boolean;
}) {
    const cls = ['sidebar-nav-row'];
    if (accent) cls.push('sidebar-nav-row--accent');
    if (active) cls.push('sidebar-nav-row--active');
    return (
        <button type="button" className={cls.join(' ')} aria-current={active ? 'page' : undefined} onClick={onClick}>
            <span className="sidebar-nav-icon">{icon}</span>
            <span className="sidebar-nav-label">{label}</span>
            {badge !== undefined && badge > 0 && (
                <span className="sidebar-nav-badge">{badge > 99 ? '99+' : badge}</span>
            )}
            {tag && <span className="sidebar-nav-tag">{tag}</span>}
            {hint && <span className="sidebar-nav-hint">{hint}</span>}
        </button>
    );
}

export function Sidebar({
    conversations,
    projects,
    currentConversationId,
    onSelectConversation,
    onNewConversation,
    onNewConversationInProject,
    onCreateProject,
    onOpenProjectSettings,
    onDeleteProject,
    onMoveConversation,
    onRenameConversation,
    onDeleteConversation,
    onClearAll,
    onConversationsChanged
}: SidebarProps) {
    const { styles, cx } = useStyles();
    const { message, modal } = App.useApp();
    const importInput = useRef<HTMLInputElement>(null);
    const searchButton = useRef<HTMLButtonElement>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchText, setSearchText] = useState('');
    const query = searchText.trim().toLocaleLowerCase();
    const closeSearch = () => {
        setSearchText('');
        setSearchOpen(false);
        requestAnimationFrame(() => searchButton.current?.focus());
    };
    const unseenAutomations = useAutomationStore((s) => s.unseenSettles);
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const selectedConversationId = pathname.startsWith('/chat/') ? (currentConversationId ?? '') : '';
    // Electron(mac) 下隐藏了原生标题栏、红绿灯浮在左上角，品牌区需让位 + 作为拖拽区移动窗口。
    // dev:web(无 preload) 下 zhuixun 为空 → 不加平台类，拖拽/让位均不生效(浏览器本就无效)。
    const isMac = window.zhuixun?.platform === 'darwin';
    // 生成中的会话：给对应会话项标注 loading，切走后仍能看出它在后台运行
    const streamingIds = useStreamingConversations();
    const messagesById = useChatStore((state) => state.messagesById);
    const attentionById = useMemo(() => {
        const states = new Map<string, 'waiting' | 'failed' | 'stopped'>();
        for (const [id, messages] of Object.entries(messagesById)) {
            if (collectPendingInteractions(messages).length) {
                states.set(id, 'waiting');
                continue;
            }
            const last = messages.at(-1);
            if (
                last?.role === 'assistant' &&
                last.metadata &&
                typeof last.metadata === 'object' &&
                'stopReason' in last.metadata
            ) {
                states.set(id, last.metadata.stopReason === 'error' ? 'failed' : 'stopped');
            }
        }
        return states;
    }, [messagesById]);

    const renderConversationLabel = (conv: ConversationLite, canMove: boolean) => {
        const targets = canMove ? moveTargets(conv) : [];
        const items: MenuProps['items'] = [
            {
                key: 'rename',
                label: '重命名',
                icon: <EditOutlined />,
                onClick: () => openRename(conv)
            }
        ];
        if (canMove) {
            items.push({
                key: 'move',
                label: '移动到项目',
                icon: <SwapOutlined />,
                disabled: targets.length === 0,
                children: targets
            });
        }
        items.push(
            {
                key: 'export',
                label: '导出会话',
                icon: <DownloadOutlined />,
                onClick: () => void handleExportOne(conv.id)
            },
            {
                key: 'delete',
                label: '删除会话',
                icon: <DeleteOutlined style={{ color: colors.error }} />,
                onClick: () => onDeleteConversation?.(conv.id)
            }
        );
        const status = streamingIds.has(conv.id) ? 'running' : attentionById.get(conv.id);
        const label =
            status === 'running' ? '运行中' : status === 'waiting' ? '待确认' : status === 'failed' ? '失败' : '已停止';
        return (
            <span className="sidebar-conv-label" aria-current={conv.id === selectedConversationId ? 'true' : undefined}>
                <span className="sidebar-conv-title" title={conv.title}>
                    {conv.title}
                </span>
                {status && (
                    <span className={`sidebar-conv-state is-${status}`} title={label} aria-label={label} role="img">
                        {status === 'running' ? (
                            <LoadingOutlined />
                        ) : status === 'waiting' ? (
                            <SafetyOutlined />
                        ) : (
                            <ExclamationCircleOutlined />
                        )}
                    </span>
                )}
                {/* Conversations 内置菜单固定为点击触发，行内菜单自行配置悬停，并保留触屏和键盘点击。 */}
                <Dropdown
                    trigger={['hover', 'click']}
                    placement="bottomRight"
                    openClassName="sidebar-conv-menu-open"
                    menu={{ items, onClick: ({ domEvent }) => domEvent.stopPropagation() }}
                >
                    <button
                        type="button"
                        className="sidebar-conv-meta"
                        aria-label="会话操作"
                        aria-haspopup="menu"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <span className="sidebar-conv-time">{formatTime(conv.updatedAt)}</span>
                        <EllipsisOutlined className="sidebar-conv-menu-icon" />
                    </button>
                </Dropdown>
            </span>
        );
    };

    // 重命名弹窗：记录目标会话（id + 原标题），输入值由 Form 托管
    const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
    const [renameForm] = Form.useForm<{ title: string }>();
    const openRename = (conv: ConversationLite) => {
        setRenameTarget({ id: conv.id, title: conv.title });
        renameForm.setFieldsValue({ title: conv.title });
    };
    const handleRenameConfirm = (values: { title: string }) => {
        const next = values.title.trim();
        if (!renameTarget || !next) return;
        if (next !== renameTarget.title) onRenameConversation?.(renameTarget.id, next);
        setRenameTarget(null);
    };

    // 按项目分桶：真实项目按列表顺序，未分组桶置底。渠道会话不进项目分桶，单独走「渠道」分区。
    const groups = useMemo(() => {
        const byProject = new Map<string, ConversationLite[]>();
        for (const conv of conversations) {
            if (conv.origin?.kind === 'channel') continue;
            const key = conv.projectId || UNGROUPED;
            const bucket = byProject.get(key);
            if (bucket) bucket.push(conv);
            else byProject.set(key, [conv]);
        }
        for (const list of byProject.values()) {
            list.sort((a, b) => b.updatedAt - a.updatedAt);
        }
        const ordered: { key: string; name: string; isProject: boolean; items: ConversationLite[] }[] = [];
        for (const p of projects) {
            ordered.push({ key: p.id, name: p.name, isProject: true, items: byProject.get(p.id) ?? [] });
        }
        ordered.push({ key: UNGROUPED, name: '未分组', isProject: false, items: byProject.get(UNGROUPED) ?? [] });
        return ordered;
    }, [conversations, projects]);

    // 「渠道」分区：按 渠道(channelId) → IM 联系人会话 两级分桶。
    const channelGroups = useMemo(() => {
        const byChannel = new Map<string, { name: string; items: ConversationLite[] }>();
        for (const conv of conversations) {
            if (conv.origin?.kind !== 'channel') continue;
            const { channelId, channelName } = conv.origin;
            const bucket = byChannel.get(channelId);
            if (bucket) bucket.items.push(conv);
            else byChannel.set(channelId, { name: channelName || channelId, items: [conv] });
        }
        const ordered: { key: string; name: string; items: ConversationLite[] }[] = [];
        for (const [key, { name, items }] of byChannel) {
            items.sort((a, b) => b.updatedAt - a.updatedAt);
            ordered.push({ key, name, items });
        }
        return ordered;
    }, [conversations]);

    // 「移动到项目」子菜单项：其余项目 + 未分组（排除会话当前所在分组）
    const moveTargets = (conv: ConversationLite) => {
        const targets: { key: string; label: string; onClick: () => void }[] = [];
        for (const p of projects) {
            if (p.id === conv.projectId) continue;
            targets.push({ key: p.id, label: p.name, onClick: () => onMoveConversation(conv.id, p.id) });
        }
        if (conv.projectId) {
            targets.push({ key: UNGROUPED, label: '未分组', onClick: () => onMoveConversation(conv.id, null) });
        }
        return targets;
    };

    // 分组展开态：默认全开（含新建的项目组），只记录用户「主动折叠」的组。
    const [collapsedChannelKeys, setCollapsedChannelKeys] = useState<string[]>([]);
    const [collapsedKeys, setCollapsedKeys] = useState<string[]>([]);
    const activeGroupKeys = groups.map((g) => g.key).filter((k) => !collapsedKeys.includes(k));
    const handleGroupsChange = (keys: string | string[]) => {
        const open = new Set(Array.isArray(keys) ? keys : [keys]);
        setCollapsedKeys(groups.map((g) => g.key).filter((k) => !open.has(k)));
    };

    const visibleGroups = query
        ? groups
              .map((group) => ({
                  ...group,
                  items: group.items.filter((conv) => conv.title.toLocaleLowerCase().includes(query))
              }))
              .filter((group) => group.items.length > 0)
        : groups;
    const collapseItems = visibleGroups.map((group) => {
        return {
            key: group.key,
            label: (
                <div className="sidebar-group-label">
                    {group.isProject ? <FolderOutlined /> : <InboxOutlined className="sidebar-group-inbox-icon" />}
                    <span className="sidebar-group-name" title={group.name}>
                        {group.name}
                    </span>
                </div>
            ),
            extra: (
                <div className="sidebar-group-actions" onClick={(e) => e.stopPropagation()}>
                    <Tooltip title="在此新建对话">
                        <PlusOutlined onClick={() => onNewConversationInProject(group.isProject ? group.key : null)} />
                    </Tooltip>
                    {group.isProject && (
                        <>
                            <Tooltip title="项目设置">
                                <EditOutlined onClick={() => onOpenProjectSettings(group.key)} />
                            </Tooltip>
                            <Popconfirm
                                title="删除项目"
                                description="删除后该项目下的会话将移到「未分组」，不会被删除。"
                                onConfirm={() => onDeleteProject(group.key)}
                                okText="删除项目"
                                cancelText="取消"
                                okButtonProps={{ danger: true }}
                            >
                                <Tooltip title="删除项目">
                                    <DeleteOutlined style={{ color: colors.error }} />
                                </Tooltip>
                            </Popconfirm>
                        </>
                    )}
                </div>
            ),
            children:
                group.items.length > 0 ? (
                    <Conversations
                        items={group.items.map((conv) => ({
                            key: conv.id,
                            label: renderConversationLabel(conv, true)
                        }))}
                        activeKey={selectedConversationId}
                        onActiveChange={(key) => onSelectConversation(key as string)}
                    />
                ) : (
                    <div className="sidebar-group-empty">暂无会话</div>
                )
        };
    });

    const visibleChannelGroups = query
        ? channelGroups
              .map((group) => ({
                  ...group,
                  items: group.items.filter((conv) => conv.title.toLocaleLowerCase().includes(query))
              }))
              .filter((group) => group.items.length > 0)
        : channelGroups;
    const channelCollapseItems = visibleChannelGroups.map((group) => ({
        key: `channel:${group.key}`,
        label: (
            <div className="sidebar-group-label">
                <MessageOutlined />
                <span className="sidebar-group-name" title={group.name}>
                    {group.name}
                </span>
            </div>
        ),
        children:
            group.items.length > 0 ? (
                <Conversations
                    items={group.items.map((conv) => ({
                        key: conv.id,
                        label: renderConversationLabel(conv, false)
                    }))}
                    activeKey={selectedConversationId}
                    onActiveChange={(key) => onSelectConversation(key as string)}
                />
            ) : (
                <div className="sidebar-group-empty">暂无会话</div>
            )
    }));

    const handleNavigateToSkills = () => navigate('/skills');
    const handleNavigateToSettings = () => navigate('/settings');
    const handleNavigateToAutomations = () => navigate('/automations');

    // 导出单个会话全量为 JSON 文件
    const handleExportOne = async (convId: string) => {
        const res = await fetchConversationApi(convId);
        if (res.code === SUCCESS_CODE && res.data) {
            downloadJson(`conversation-${convId}.json`, res.data);
        }
    };

    // 导出全部会话
    const handleExportAll = async () => {
        const res = await exportConversationsApi();
        if (res.code === SUCCESS_CODE && res.data) {
            const stamp = dayjs().format('YYYY-MM-DD');
            downloadJson(`追寻-conversations-${stamp}.json`, res.data);
            message.info(`正在导出 ${res.data.conversations.length} 个会话，请在下载中查看文件`);
        }
    };

    // 导入：读取 JSON 文件（导出包或会话数组），提交后端，刷新列表
    const handleImportFile = async (file: File) => {
        try {
            const text = await file.text();
            const parsed = JSON.parse(text) as { conversations?: SavedConversation[] } | SavedConversation[];
            const conversations = Array.isArray(parsed) ? parsed : (parsed.conversations ?? []);
            if (!Array.isArray(conversations) || conversations.length === 0) {
                message.warning('文件中没有可导入的会话');
                return;
            }
            const res = await importConversationsApi(conversations);
            if (res.code === SUCCESS_CODE && res.data) {
                message.success(`已导入 ${res.data.imported} 个会话`);
                onConversationsChanged?.();
            }
        } catch {
            message.error('导入失败：文件格式不正确');
        }
    };

    return (
        <div className={cx('sidebar', isMac && 'platform-darwin', styles.toString())}>
            <div className="sidebar-brand">
                <BrandMark />
                <div className="sidebar-brand-text">
                    <span className="sidebar-brand-name">追寻</span>
                </div>
            </div>

            <nav className="sidebar-nav">
                <NavRow icon={<PlusOutlined />} label="新建对话" onClick={onNewConversation} accent />
                <NavRow
                    icon={<ApiOutlined />}
                    label="技能 + 连接器"
                    onClick={handleNavigateToSkills}
                    active={pathname.startsWith('/skills') || pathname.startsWith('/skill-market')}
                />
                <NavRow
                    icon={<ClockCircleOutlined />}
                    label="自动化任务"
                    onClick={handleNavigateToAutomations}
                    active={pathname.startsWith('/automations')}
                    badge={unseenAutomations}
                />
            </nav>

            <div className="sidebar-section">
                <div className="sidebar-section-header">
                    <span className="sidebar-section-title">项目与会话</span>
                    <div className="sidebar-section-actions">
                        <Tooltip title="搜索会话">
                            <Button
                                ref={searchButton}
                                type="text"
                                size="small"
                                aria-label="搜索会话"
                                aria-expanded={searchOpen}
                                icon={<SearchOutlined />}
                                onClick={() => {
                                    if (searchOpen) closeSearch();
                                    else setSearchOpen(true);
                                }}
                            />
                        </Tooltip>
                        <Tooltip title="新建项目">
                            <Button
                                type="text"
                                size="small"
                                aria-label="新建项目"
                                icon={<FolderAddOutlined />}
                                onClick={onCreateProject}
                            />
                        </Tooltip>
                        <Dropdown
                            trigger={['click']}
                            placement="bottomRight"
                            menu={{
                                items: [
                                    {
                                        key: 'import',
                                        label: '导入会话…',
                                        icon: <ImportOutlined />,
                                        onClick: () => importInput.current?.click()
                                    },
                                    {
                                        key: 'export',
                                        label: '导出全部会话',
                                        icon: <ExportOutlined />,
                                        onClick: () => void handleExportAll()
                                    },
                                    { type: 'divider' },
                                    {
                                        key: 'clear',
                                        label: '清空所有会话…',
                                        icon: <ClearOutlined />,
                                        danger: true,
                                        disabled: !conversations.length || !onClearAll,
                                        onClick: () => {
                                            modal.confirm({
                                                title: '清空所有会话',
                                                content: '会话记录将被永久删除，项目会保留。',
                                                okText: '清空会话',
                                                cancelText: '取消',
                                                okButtonProps: { danger: true },
                                                onOk: onClearAll
                                            });
                                        }
                                    }
                                ]
                            }}
                        >
                            <Button type="text" size="small" aria-label="会话管理" icon={<MoreOutlined />} />
                        </Dropdown>
                        <input
                            hidden
                            type="file"
                            accept="application/json,.json"
                            ref={importInput}
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                event.currentTarget.value = '';
                                if (file) void handleImportFile(file);
                            }}
                        />
                    </div>
                </div>
                {searchOpen && (
                    <Input
                        className="sidebar-search"
                        size="small"
                        autoFocus
                        allowClear
                        aria-label="按会话名称搜索"
                        placeholder="搜索会话"
                        prefix={<SearchOutlined />}
                        value={searchText}
                        onChange={(event) => setSearchText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape' && !event.nativeEvent.isComposing) closeSearch();
                        }}
                    />
                )}
                <div className="sidebar-conversations">
                    {query && !collapseItems.length && !channelCollapseItems.length && (
                        <p className="sidebar-group-empty" role="status">
                            没有匹配的会话
                        </p>
                    )}
                    <Collapse
                        ghost
                        activeKey={query ? visibleGroups.map((group) => group.key) : activeGroupKeys}
                        onChange={query ? undefined : handleGroupsChange}
                        items={collapseItems}
                        className="sidebar-groups"
                    />

                    {visibleChannelGroups.length > 0 && (
                        <>
                            <div className="sidebar-subsection-title">渠道</div>
                            <Collapse
                                ghost
                                activeKey={visibleChannelGroups
                                    .map((group) => `channel:${group.key}`)
                                    .filter((key) => query || !collapsedChannelKeys.includes(key))}
                                onChange={
                                    query
                                        ? undefined
                                        : (keys) => {
                                              const open = new Set(Array.isArray(keys) ? keys : [keys]);
                                              setCollapsedChannelKeys(
                                                  channelGroups
                                                      .map((group) => `channel:${group.key}`)
                                                      .filter((key) => !open.has(key))
                                              );
                                          }
                                }
                                items={channelCollapseItems}
                                className="sidebar-groups"
                            />
                        </>
                    )}
                </div>
            </div>

            <div className="sidebar-footer">
                <NavRow
                    icon={<SettingOutlined />}
                    label="设置"
                    onClick={handleNavigateToSettings}
                    active={pathname.startsWith('/settings')}
                />
            </div>

            <Modal
                title="重命名会话"
                open={!!renameTarget}
                onOk={() => renameForm.submit()}
                onCancel={() => setRenameTarget(null)}
            >
                <Form form={renameForm} onFinish={handleRenameConfirm}>
                    <Form.Item name="title" rules={[{ required: true, message: '请输入会话标题' }]}>
                        <Input placeholder="输入会话标题" maxLength={50} autoFocus />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
