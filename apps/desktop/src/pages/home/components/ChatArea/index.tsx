import { FolderOutlined, SlidersOutlined } from '@ant-design/icons';
import { Alert, App, Select } from 'antd';
import { useMemo } from 'react';

import PageHeader from '@/components/PageHeader';
import { useSlashCommand } from '@/hooks';

import { ApprovalDock } from '../approval/ApprovalDock';
import { useChatActions, useChatRun } from '../chat-context';
import { ChatTranscript } from '../ChatTranscript';
import { GoalBanner } from '../GoalBanner';
import { InputBox } from '../InputBox';
import { ToolLabelContext } from '../tool-label-context';
import { useToolLabels } from '../useToolLabels';

import useStyles from './styles';

/** 归属下拉里「未分组」的固定值（不与真实项目 uuid 冲突） */
const UNGROUPED = '__ungrouped__';
const DEFAULT_PERSONA_VALUE = '__default__';

interface ChatAreaProps {
    disabled?: boolean;
    /** 切换会话时异步拉取历史消息中的 loading 态 */
    messagesLoading?: boolean;
    /** 会话切换时用于重置滚动锁定状态，让新会话总是从底部展示 */
    conversationKey?: string;
    /** 当前会话标题（草稿为「新对话」） */
    title?: string;
    /** 归属条：是否展示（渠道会话隐藏） */
    showProjectSelect?: boolean;
    /** 可选项目列表（归属条下拉） */
    projectOptions?: { id: string; name: string }[];
    /** 当前归属项目 id；null=未分组 */
    projectId?: string | null;
    /** 改归属回调：草稿改默认目标，已落库会话触发移动 */
    onChangeProject?: (projectId: string | null) => void;
    /** 可选风格列表（内置 + 自定义） */
    personaOptions?: { id: string; name: string; kind: 'builtin' | 'custom' }[];
    /** 全局默认风格 id */
    defaultPersonaId?: string;
    /** 当前会话覆盖值；undefined 表示跟随默认 */
    personaId?: string;
    /** 是否展示风格下拉（渠道会话隐藏） */
    showPersonaSelect?: boolean;
    /** 切换风格；null 表示跟随默认 */
    onChangePersona?: (personaId: string | null) => void;
}

/**
 * 会话区外壳：标题栏（含实时任务进度）+ 报错条 + 消息滚动区 + 输入框。
 *
 * 流式相关的状态与动作全部经 `ChatSession` 的 Context 取得，不再作为 props 透传：
 * 这里的运行态只在 status / error 变化时更新，标题栏的 Select、输入框不随 token 重渲染。
 */
export function ChatArea({
    disabled,
    messagesLoading,
    conversationKey,
    title,
    showProjectSelect,
    projectOptions = [],
    projectId,
    onChangeProject,
    personaOptions = [],
    defaultPersonaId = 'default',
    personaId,
    showPersonaSelect,
    onChangePersona
}: ChatAreaProps) {
    const { styles, cx } = useStyles();
    const { labels: toolLabels } = useToolLabels();
    const { message } = App.useApp();
    const { loading, error, pendingInteractionCount } = useChatRun();
    const actions = useChatActions();
    // 输入框发送入口：待确认操作未处理完时拦住发送，避免旧 run 未结算就开新一轮；
    // 其余情况识别 slash 命令（内置命令本地处理、用户命令先展开），再原样发送。
    const handleSend = useSlashCommand(async (content, attachments, command) => {
        if (pendingInteractionCount > 0) {
            message.warning('请先处理输入框上方的待确认操作');
            return;
        }
        await actions.send(content, attachments, command);
    });

    const defaultPersonaName = personaOptions.find((persona) => persona.id === defaultPersonaId)?.name;
    const personaGroups = useMemo(
        () =>
            [
                {
                    label: '内置',
                    options: personaOptions
                        .filter((persona) => persona.kind === 'builtin')
                        .map((persona) => ({ value: persona.id, label: persona.name }))
                },
                {
                    label: '我的风格',
                    options: personaOptions
                        .filter((persona) => persona.kind === 'custom')
                        .map((persona) => ({ value: persona.id, label: persona.name }))
                }
            ].filter((group) => group.options.length > 0),
        [personaOptions]
    );

    return (
        <div className={cx('chat-area', styles.toString())}>
            <PageHeader>
                <span className="chat-area-title" title={title}>
                    {title}
                </span>
                <div className="chat-area-actions">
                    {showPersonaSelect && (
                        <div className="chat-area-persona">
                            <SlidersOutlined aria-hidden />
                            <Select
                                aria-label="回复风格"
                                variant="borderless"
                                size="small"
                                value={personaId ?? DEFAULT_PERSONA_VALUE}
                                onChange={(value) => onChangePersona?.(value === DEFAULT_PERSONA_VALUE ? null : value)}
                                popupMatchSelectWidth={false}
                                options={[
                                    {
                                        value: DEFAULT_PERSONA_VALUE,
                                        label: defaultPersonaName ? `跟随默认 · ${defaultPersonaName}` : '跟随默认'
                                    },
                                    ...personaGroups
                                ]}
                            />
                        </div>
                    )}
                    {showProjectSelect && (
                        <div className="chat-area-project">
                            <FolderOutlined aria-hidden />
                            <Select
                                aria-label="归属项目"
                                variant="borderless"
                                size="small"
                                value={projectId ?? UNGROUPED}
                                onChange={(v) => onChangeProject?.(v === UNGROUPED ? null : v)}
                                popupMatchSelectWidth={false}
                                options={[
                                    { value: UNGROUPED, label: '未分组' },
                                    ...projectOptions.map((p) => ({ value: p.id, label: p.name }))
                                ]}
                            />
                        </div>
                    )}
                </div>
            </PageHeader>

            {error && (
                <Alert
                    type="error"
                    showIcon
                    title="回复生成失败"
                    description={error.message}
                    className="chat-area-alert"
                />
            )}

            <ToolLabelContext.Provider value={toolLabels}>
                <div className="chat-area-workspace">
                    <ChatTranscript conversationKey={conversationKey} messagesLoading={messagesLoading} />
                    <ApprovalDock />
                    <div className="chat-area-composer">
                        <GoalBanner />
                        <InputBox
                            onSend={handleSend}
                            onStop={actions.stop}
                            disabled={disabled}
                            loading={loading}
                            blocked={pendingInteractionCount > 0}
                        />
                    </div>
                </div>
            </ToolLabelContext.Provider>
        </div>
    );
}
