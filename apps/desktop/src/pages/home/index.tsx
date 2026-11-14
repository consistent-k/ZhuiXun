import { LoadingOutlined } from '@ant-design/icons';
import { App, Tag } from 'antd';
import { useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'react-router';

import { useBackgroundStreamCount } from '@/hooks';
import { useChatStore, usePersonaStore, useProjectStore } from '@/stores';

import { ChatArea } from './components/ChatArea';
import { ChatSession } from './components/ChatSession';
import useStyles from './styles';

const HomePage = () => {
    const { styles, cx } = useStyles();

    const { message } = App.useApp();
    const { conversations, currentConversationId, draftPersonaById, setConversationPersona, setDraftPersona } =
        useChatStore();
    const listLoaded = useChatStore((s) => s.listLoaded);
    const messagesById = useChatStore((s) => s.messagesById);
    const moveConversation = useChatStore((s) => s.moveConversation);
    const projects = useProjectStore((s) => s.projects);
    const currentProjectId = useProjectStore((s) => s.currentProjectId);
    const personaItems = usePersonaStore((s) => s.items);
    const defaultPersonaId = usePersonaStore((s) => s.defaultId);

    const { conversationId } = useParams();

    // 本页不再调用 useChat：流式状态与动作由 ChatSession 经 Context 下发，
    // 否则每次 token 提交都会重渲染整页（标题栏 Select、输入框等）。
    const backgroundStreamCount = useBackgroundStreamCount(currentConversationId);

    // 当前会话在列表中但消息尚未拉进缓存时，展示历史加载态（派生，不用 effect + setState）
    const messagesLoading =
        !!conversationId &&
        listLoaded &&
        conversations.some((c) => c.id === conversationId) &&
        !messagesById[conversationId];

    // URL 是「当前会话」的唯一事实源：路由变化时同步到 store。
    // 门闩：列表未从后端加载完成前不判定，否则合法深链会因「列表还空」被误判为新会话。
    // URL 恒带会话 id（根路径 / 已重定向到 /chat/<uuid>）。id 不在列表中 =
    // 未落库的新建草稿 / 失效深链 → 一律当空白新会话（不拉消息、不重定向，见技术方案 §8）。
    // 已落库会话：激活前先把消息拉进缓存，保证 useChat 建 Chat 实例时初始消息已就绪。
    useEffect(() => {
        if (!listLoaded) return;
        const store = useChatStore.getState();
        if (!conversationId) {
            store.setCurrentConversation(null);
            return;
        }
        const known = store.conversations.some((c) => c.id === conversationId);
        if (!known || store.messagesById[conversationId]) {
            store.setCurrentConversation(conversationId);
            return;
        }
        let cancelled = false;
        void store.loadMessages(conversationId).then(() => {
            if (!cancelled) store.setCurrentConversation(conversationId);
        });
        return () => {
            cancelled = true;
        };
    }, [conversationId, listLoaded]);

    // 归属条数据：已落库会话取其 projectId；未落库草稿取运行时态 currentProjectId。
    // 渠道会话按渠道分桶、不归项目，隐藏归属条避免误导。
    const currentConv = conversations.find((c) => c.id === currentConversationId);
    const isChannelConv = currentConv?.origin?.kind === 'channel';
    const headerProjectId = currentConv ? (currentConv.projectId ?? null) : currentProjectId;
    const knownPersonaId =
        currentConv?.personaId && personaItems.some((item) => item.id === currentConv.personaId)
            ? currentConv.personaId
            : undefined;
    const headerPersonaId = currentConv
        ? knownPersonaId
        : currentConversationId
          ? draftPersonaById[currentConversationId]
          : undefined;

    // 改归属：草稿只改默认落点（运行时态）；已落库会话触发移动并提示落点
    const handleChangeProject = useCallback(
        (projectId: string | null) => {
            if (currentConv) {
                moveConversation(currentConv.id, projectId);
                const name = projectId ? projects.find((p) => p.id === projectId)?.name : '未分组';
                message.success(`已移动到「${name ?? '项目'}」`);
            } else {
                useProjectStore.getState().setCurrentProject(projectId);
            }
        },
        [currentConv, moveConversation, projects, message]
    );

    const handleChangePersona = useCallback(
        (personaId: string | null) => {
            const name = personaId ? personaItems.find((item) => item.id === personaId)?.name : undefined;
            if (currentConv) {
                setConversationPersona(currentConv.id, personaId);
            } else if (currentConversationId) {
                setDraftPersona(currentConversationId, personaId);
            }
            message.success(personaId ? `已切换为「${name ?? '自定义风格'}」，从下一条消息起生效` : '已跟随默认风格');
        },
        [currentConv, currentConversationId, personaItems, setConversationPersona, setDraftPersona, message]
    );

    // 下拉选项数组按引用缓存：ChatArea 的 Select 只要 options 引用不变就不会重建
    const projectOptions = useMemo(() => projects.map((p) => ({ id: p.id, name: p.name })), [projects]);
    const personaOptions = useMemo(
        () => personaItems.map((item) => ({ id: item.id, name: item.name, kind: item.kind })),
        [personaItems]
    );

    return (
        <div className={cx('home-page', styles.toString())}>
            <ChatSession>
                <ChatArea
                    messagesLoading={messagesLoading}
                    conversationKey={currentConversationId ?? 'draft'}
                    title={currentConv?.title ?? '新对话'}
                    showProjectSelect={!isChannelConv}
                    projectOptions={projectOptions}
                    projectId={headerProjectId}
                    onChangeProject={handleChangeProject}
                    personaOptions={personaOptions}
                    defaultPersonaId={defaultPersonaId}
                    personaId={headerPersonaId}
                    showPersonaSelect={!isChannelConv}
                    onChangePersona={handleChangePersona}
                />
            </ChatSession>
            {backgroundStreamCount > 0 && (
                <div className="home-page-background-streams">
                    <Tag icon={<LoadingOutlined />} color="processing">
                        另有 {backgroundStreamCount} 个会话正在生成回复
                    </Tag>
                </div>
            )}
        </div>
    );
};

export default HomePage;
