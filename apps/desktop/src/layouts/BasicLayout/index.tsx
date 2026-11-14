import { App } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';

import { useAutomationEvents, useChannelEvents, useSessionEvents } from '@/hooks';
import { useAutomationStore, useChatStore, useProjectStore, useSessionRuntimeStore } from '@/stores';
import { chatRegistry } from '@/stores/chatRegistry';

import { Sidebar } from '../Sidebar';

import { ProjectCreateModal } from './components/ProjectCreateModal';
import useStyles from './styles';

/** 全局主布局：承载会话侧边栏，内容区由子路由通过 Outlet 渲染 */
const BasicLayout = () => {
    const { styles, cx } = useStyles();
    const navigate = useNavigate();
    const { message, notification } = App.useApp();
    const { conversations, currentConversationId, deleteConversation, clearAll, moveConversation, renameConversation } =
        useChatStore();
    const projects = useProjectStore((s) => s.projects);
    const { pathname } = useLocation();
    const [createProjectOpen, setCreateProjectOpen] = useState(false);

    // 启动时从后端加载会话列表 + 项目列表（会话含一次性 localStorage 迁移）；
    // 列表就绪后对后端仍在进行的会话恢复流式（刷新可恢复）
    useEffect(() => {
        void useChatStore
            .getState()
            .hydrate()
            .then(() => chatRegistry.resumeActive());
        useProjectStore.getState().hydrate();
    }, []);

    // 渠道消息事件（SSE）：收到 inbound/reply/error 即刷新会话列表，让侧栏「渠道」分区实时上浮/出现。
    // 列表刷新节流 800ms；若事件属于当前打开的会话，另外重载其消息（含新用户气泡与 AI 回复），
    // 让正打开该会话的桌面端无需刷新即可看到更新。
    const lastRefreshRef = useRef(0);
    useChannelEvents(
        useCallback((event) => {
            const now = Date.now();
            if (now - lastRefreshRef.current >= 800) {
                lastRefreshRef.current = now;
                void useChatStore.getState().refreshList();
            }
            const curId = useChatStore.getState().currentConversationId;
            if (event.sessionId && event.sessionId === curId) {
                void chatRegistry.reloadConversation(event.sessionId);
            }
        }, [])
    );

    // 通知分流：桌面端且窗口不在前台 → 系统桌面通知；否则（浏览器 / 桌面端在前台）→ 应用内 notification。
    // 桌面端桥接在 preload 里，web 下 `window.zhuixun` 不存在，自然走应用内通知。
    //
    // 系统通知不一定成功：macOS 下开发态 Electron 未获通知授权时，主进程会收到 failed 事件并返回
    // false（见 electron/main.ts）。这时不能当成功处理——先把消息暂存，等窗口重新获得焦点再以应用内
    // 通知补发；否则用户离开应用期间收到的提醒会彻底消失（定时提醒最常见的场景）。
    const pendingNoticesRef = useRef<Array<{ level: 'success' | 'error'; title: string; detail?: string }>>([]);

    const showInAppNotice = useCallback(
        (level: 'success' | 'error', title: string, detail?: string) => {
            if (level === 'success') {
                notification.success({ message: title, description: detail, placement: 'bottomRight' });
            } else {
                notification.error({ message: title, description: detail, placement: 'bottomRight' });
            }
        },
        [notification]
    );

    const notifyUser = useCallback(
        async (level: 'success' | 'error', title: string, detail?: string) => {
            const bridge = typeof window !== 'undefined' ? window.zhuixun : undefined;
            const isDesktop = typeof bridge?.showNotification === 'function';
            const inForeground =
                typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
            if (isDesktop && !inForeground) {
                const sent = bridge?.showNotification?.({ title, body: detail });
                const shown = sent ? await sent.catch(() => false) : false;
                if (shown) return;
                pendingNoticesRef.current.push({ level, title, detail });
                return;
            }
            showInAppNotice(level, title, detail);
        },
        [showInAppNotice]
    );

    // 窗口回到前台时补发离开期间未送达的提醒（系统通知失败，或应用当时在后台）。
    useEffect(() => {
        const flush = () => {
            if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
            const pending = pendingNoticesRef.current;
            if (pending.length === 0) return;
            pendingNoticesRef.current = [];
            pending.forEach((item) => showInAppNotice(item.level, item.title, item.detail));
        };
        window.addEventListener('focus', flush);
        document.addEventListener('visibilitychange', flush);
        return () => {
            window.removeEventListener('focus', flush);
            document.removeEventListener('visibilitychange', flush);
        };
    }, [showInAppNotice]);

    // 自动化任务事件（SSE）：后台执行会把「计划消息 + 结果」写进（新建或已有的）会话，而会话列表
    // 只在启动/渠道事件时刷新。这里在 settle（一次运行结束、已落库）后刷新列表，让侧栏立刻出现新会话；
    // 若正好打开着该会话，再重载其消息。节流 800ms 与渠道事件一致。
    // 同时补一个完成通知与侧栏角标：用户没打开管理页时也能知道任务跑完了。
    const lastAutoRefreshRef = useRef(0);
    useAutomationEvents(
        useCallback(
            (event) => {
                if (event.type !== 'settle') return;
                const now = Date.now();
                if (now - lastAutoRefreshRef.current >= 800) {
                    lastAutoRefreshRef.current = now;
                    void useChatStore.getState().refreshList();
                }
                const curId = useChatStore.getState().currentConversationId;
                if (event.conversationId && event.conversationId === curId) {
                    void chatRegistry.reloadConversation(event.conversationId);
                }

                // 正在管理页时列表/抽屉已经实时反映，不再累加角标/弹通知，避免重复打扰。
                if (!pathname.startsWith('/automations')) {
                    useAutomationStore.getState().noteSettle();
                    // 标题优先取事件自带值：未打开管理页时列表未 hydrate，本地查不到任务名。
                    const title = event.title || `任务 #${event.automationId}`;
                    if (event.outcome === 'succeeded') {
                        notifyUser('success', '定时任务已完成', title);
                    } else if (event.outcome === 'failed') {
                        notifyUser('error', '定时任务执行失败', event.error ? `${title}：${event.error}` : title);
                    }
                }
            },
            [pathname, notifyUser]
        )
    );

    // 会话运行事件（SSE）：后台任务完成唤醒 / 自驱轮次都会在无请求的情况下推进会话。
    // turn-end（非真人）后刷新列表与当前会话；job/goal 事件同步到 store 供 toast 与 Goal 横幅使用。
    useSessionEvents(
        useCallback(
            (event) => {
                if (event.type === 'turn-end' && event.source !== 'user') {
                    // 轮次结束在 onEnd 里立刻发出，落库是异步的：稍等一拍再重拉，避免读到旧消息。
                    const sessionId = event.sessionId;
                    setTimeout(() => {
                        void useChatStore.getState().refreshList();
                        if (useChatStore.getState().currentConversationId === sessionId) {
                            void chatRegistry.reloadConversation(sessionId);
                        }
                    }, 500);
                    return;
                }
                if (event.type === 'job') {
                    useSessionRuntimeStore.getState().setJob(event.job);
                    if (event.job.status === 'succeeded') {
                        notifyUser('success', '后台任务已完成', event.job.title);
                    } else if (event.job.status === 'failed') {
                        const detail = event.job.error ? `${event.job.title}：${event.job.error}` : event.job.title;
                        notifyUser('error', '后台任务执行失败', detail);
                    }
                    return;
                }
                if (event.type === 'goal') {
                    useSessionRuntimeStore.getState().setGoal(event.goal);
                }
            },
            [notifyUser]
        )
    );

    // 有后台任务在跑时请求主进程阻止系统休眠（浏览器环境无此桥接，静默跳过）。
    const runningJobCount = useSessionRuntimeStore((s) => Object.keys(s.runningJobs).length);
    const keepAwake = runningJobCount > 0;
    useEffect(() => {
        window.zhuixun?.setKeepAwake?.(keepAwake);
        return () => {
            if (keepAwake) window.zhuixun?.setKeepAwake?.(false);
        };
    }, [keepAwake]);

    // 新建对话：顶部按钮是「通用新对话」，确定性落到未分组（重置运行时态项目），再定 id 进 URL。
    // 想建到某个项目用该项目行右侧的「+」。顶部归属条即时标明归属。
    const handleNewConversation = useCallback(() => {
        useProjectStore.getState().setCurrentProject(null);
        navigate(`/chat/${crypto.randomUUID()}`);
    }, [navigate]);

    // 在指定分组下新建对话：先把该分组设为当前项目，再定 id 进 URL
    const handleNewConversationInProject = useCallback(
        (projectId: string | null) => {
            useProjectStore.getState().setCurrentProject(projectId);
            navigate(`/chat/${crypto.randomUUID()}`);
        },
        [navigate]
    );

    const handleSelectConversation = useCallback(
        (convId: string) => {
            // 选中会话时同步「当前项目」，让随后的新建对话默认落到同一项目
            const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
            useProjectStore.getState().setCurrentProject(conv?.projectId ?? null);
            navigate(`/chat/${convId}`);
        },
        [navigate]
    );

    const handleDeleteConversation = useCallback(
        (convId: string) => {
            const wasCurrent = useChatStore.getState().currentConversationId === convId;
            deleteConversation(convId);
            if (wasCurrent) navigate('/');
            message.success('会话已删除');
        },
        [deleteConversation, navigate, message]
    );

    const handleClearAll = useCallback(() => {
        clearAll();
        navigate('/');
        message.success('所有会话已清空');
    }, [clearAll, navigate, message]);

    const handleMoveConversation = useCallback(
        (convId: string, projectId: string | null) => {
            moveConversation(convId, projectId);
            const name = projectId
                ? useProjectStore.getState().projects.find((p) => p.id === projectId)?.name
                : '未分组';
            message.success(`已移动到「${name ?? '项目'}」`);
        },
        [moveConversation, message]
    );

    const handleRenameConversation = useCallback(
        (convId: string, title: string) => {
            renameConversation(convId, title);
            message.success('会话已重命名');
        },
        [renameConversation, message]
    );

    // 新建项目：打开声明式弹窗，创建成功后跳到设置页完善指令
    const handleCreateProject = useCallback(() => {
        setCreateProjectOpen(true);
    }, []);

    const handleOpenProjectSettings = useCallback(
        (projectId: string) => {
            navigate(`/project/${projectId}`);
        },
        [navigate]
    );

    const handleDeleteProject = useCallback(
        async (projectId: string) => {
            await useProjectStore.getState().deleteProject(projectId);
            // 会话归属已在后端复位为未分组，重拉列表让侧栏分桶刷新
            await useChatStore.getState().refreshList();
            message.success('项目已移入回收站，会话已移到未分组');
        },
        [message]
    );

    return (
        <div className={cx('basic-layout', styles.toString())}>
            <Sidebar
                conversations={conversations}
                projects={projects}
                currentConversationId={currentConversationId}
                onSelectConversation={handleSelectConversation}
                onNewConversation={handleNewConversation}
                onNewConversationInProject={handleNewConversationInProject}
                onCreateProject={handleCreateProject}
                onOpenProjectSettings={handleOpenProjectSettings}
                onDeleteProject={handleDeleteProject}
                onMoveConversation={handleMoveConversation}
                onRenameConversation={handleRenameConversation}
                onDeleteConversation={handleDeleteConversation}
                onClearAll={handleClearAll}
                onConversationsChanged={() => void useChatStore.getState().refreshList()}
            />
            <Outlet />
            <ProjectCreateModal
                open={createProjectOpen}
                onClose={() => setCreateProjectOpen(false)}
                onCreated={(id) => navigate(`/project/${id}`)}
            />
        </div>
    );
};

export default BasicLayout;
