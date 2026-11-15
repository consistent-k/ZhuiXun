import {
    CopyOutlined,
    FileTextOutlined,
    FolderOpenOutlined,
    ThunderboltOutlined,
    UndoOutlined
} from '@ant-design/icons';
import type { CommandPartData, TurnStopReason } from '@zhuixun/shared';
import { getToolName, type UIMessage } from 'ai';
import { App, Button, Drawer, Popconfirm, Popover, Tag } from 'antd';
import { memo, useMemo, useState, type ReactNode } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { rewindConversationApi } from '@/services';
import { useChatStore } from '@/stores';
import { chatRegistry } from '@/stores/chatRegistry';

import { ActivityGroup } from '../activity/ActivityGroup';
import { buildTimeline } from '../activity/model';
import { TimelineToolItem } from '../activity/TimelineToolItem';
import { AskQuestionCard } from '../AskQuestionCard';
import { useChatActions, usePendingQuestionIds } from '../chat-context';
import { LoopGuardNotice } from '../LoopGuardNotice';
import { StreamingMarkdown } from '../StreamingMarkdown';
import { TaskListCard } from '../TaskListCard';
import { ThinkingBlock } from '../ThinkingBlock';

import useStyles from './styles';

/** 渲染单个附件 file part：图片直接缩略展示，其它类型（PDF 等）给可点击下载的文件条。 */
function renderFilePart(part: { mediaType?: string; url?: string; filename?: string }, key: string): ReactNode {
    if (!part.url) return null;
    if (part.mediaType?.startsWith('image/')) {
        return (
            <a key={key} className="message-item-image-link" href={part.url} target="_blank" rel="noreferrer">
                <img className="message-item-image" src={part.url} alt={part.filename || '图片'} />
            </a>
        );
    }
    return (
        <a key={key} className="message-item-file" href={part.url} target="_blank" rel="noreferrer">
            <FileTextOutlined />
            <span>{part.filename || '文件'}</span>
        </a>
    );
}

interface MessageRowProps {
    message: UIMessage;
    /** 该消息是否正在流式生成 */
    streaming?: boolean;
    /** 是否为会话最后一条消息（停止提示的「继续 / 重试」只对最后一条有意义） */
    isLast?: boolean;
    /** 会话正在生成（禁用继续 / 重试）；只对最后一条有意义，其余行恒为 false */
    busy?: boolean;
}

/** assistant 消息 metadata 中与停止提示相关的字段（后端 modules/chat/service.ts 写入） */
interface StopMeta {
    stopReason?: TurnStopReason;
    steps?: number;
}

/**
 * 单条消息。用 `memo` 包住：AI SDK 的 `replaceMessage` 只克隆正在流式的那条消息，历史消息对象引用不变，
 * 所以流式更新时只有最后一行真正重渲染。回调一律走 Context（引用恒定），不进入 props。
 */
export const MessageRow = memo(function MessageRow({ message, streaming, isLast, busy }: MessageRowProps) {
    const { styles, cx } = useStyles();
    const { message: messageApi } = App.useApp();
    const actions = useChatActions();
    const pendingQuestionIds = usePendingQuestionIds();
    const currentConversationId = useChatStore((s) => s.currentConversationId);
    const isUser = message.role === 'user';
    const [resultsOpen, setResultsOpen] = useState(false);
    const timeline = useMemo(() => (isUser ? [] : buildTimeline(message.parts)), [isUser, message.parts]);
    const results = timeline.flatMap((node) =>
        node.kind === 'work' ? node.items.filter((item) => item.part.state === 'output-available') : []
    );
    const files = message.parts.filter((part) => part.type === 'file');

    /** 回滚到本条用户消息：还原该轮及其后 Write/Edit 触碰的文件，并把对话截断到此。 */
    const handleRewind = async () => {
        if (!currentConversationId) return;
        const res = await rewindConversationApi(currentConversationId, message.id);
        if (res.code !== SUCCESS_CODE || !res.data) return;
        await chatRegistry.reloadConversation(currentConversationId);
        const { restored, deleted, skipped } = res.data.files;
        messageApi.success(
            `已回滚：还原 ${restored.length} 个文件` +
                (deleted.length ? `，删除 ${deleted.length} 个新建文件` : '') +
                (skipped.length ? `，${skipped.length} 个跳过` : '')
        );
    };

    /** 复制本条消息的纯文本（拼接所有 text part，忽略附件）。 */
    const handleCopy = () => {
        const text = message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
        navigator.clipboard
            .writeText(text)
            .then(() => messageApi.success('已复制'))
            .catch(() => messageApi.error('复制失败，请手动选择'));
    };

    const content: ReactNode = isUser
        ? renderUserParts(message, cx('message-item-command-popover', styles.toString()))
        : renderAssistantParts(
              timeline,
              message.id,
              Boolean(streaming),
              'message-item-cursor',
              actions,
              currentConversationId ?? '',
              pendingQuestionIds
          );

    const stop = isUser ? undefined : (message.metadata as StopMeta | undefined);
    // 停止提示只挂在最后一条 assistant 消息上：之后用户已继续对话则不再提示
    const stopNotice =
        stop?.stopReason && isLast && !streaming ? (
            <LoopGuardNotice
                reason={stop.stopReason}
                steps={stop.steps}
                onContinue={actions.continueRun}
                onRetry={actions.regenerate}
                disabled={busy}
            />
        ) : null;

    // 助手消息无任何可见内容且非流式时，renderAssistantParts 返回 null：
    // 整条消息都不渲染，避免留下空的消息容器；出错的空消息仍保留停止提示以便重试。
    if (!isUser && content === null) {
        return stopNotice ? (
            <div className={cx('message-item-orphan-notice', styles.toString())}>{stopNotice}</div>
        ) : null;
    }

    return (
        <div
            className={cx('message-item', isUser ? 'message-item--user' : 'message-item--assistant', styles.toString())}
            id={isUser ? `chat-request-${message.id}` : undefined}
            tabIndex={isUser ? -1 : undefined}
        >
            <div className="message-item-main">
                <div className="message-item-author">
                    {!isUser && <img src="/favicon.svg" width={24} height={24} alt="" />}
                    <span>{isUser ? '你' : '追寻'}</span>
                </div>
                <div
                    className={cx(
                        'message-item-bubble',
                        isUser ? 'message-item-bubble--user' : 'message-item-bubble--assistant'
                    )}
                >
                    {content}
                </div>
                {!isUser && !streaming && !busy && (results.length > 0 || files.length > 0) && (
                    <div className="message-item-results">
                        <Button type="text" icon={<FolderOpenOutlined />} onClick={() => setResultsOpen(true)}>
                            查看结果 ·{' '}
                            {[
                                results.length ? `${results.length} 项工具输出` : '',
                                files.length ? `${files.length} 个文件` : ''
                            ]
                                .filter(Boolean)
                                .join('，')}
                        </Button>
                        <Drawer
                            title="执行结果"
                            open={resultsOpen}
                            onClose={() => setResultsOpen(false)}
                            destroyOnHidden
                        >
                            {files.length > 0 && (
                                <div className={cx('message-results-files', styles.toString())}>
                                    {files.map((file, index) => renderFilePart(file, `result-file-${index}`))}
                                </div>
                            )}
                            {results.map((item) => (
                                <TimelineToolItem key={item.toolCallId} item={item} />
                            ))}
                        </Drawer>
                    </div>
                )}
                {stopNotice}
                {/* 操作条：用户/助手都常驻占位（高度恒定），保证每条消息结构一致、间距均匀；
                    默认隐藏，悬停该条消息时淡入。回滚只对用户消息有意义。 */}
                <div className="message-item-actions">
                    <Button
                        className="message-item-action-btn"
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={handleCopy}
                    >
                        复制
                    </Button>
                    {isUser && currentConversationId && (
                        <Popconfirm
                            title="回滚到此处"
                            description="将撤销该消息之后的文件改动并截断对话，不可恢复"
                            okText="回滚"
                            cancelText="取消"
                            onConfirm={handleRewind}
                        >
                            <Button
                                className="message-item-action-btn"
                                type="text"
                                size="small"
                                icon={<UndoOutlined />}
                            >
                                回滚
                            </Button>
                        </Popconfirm>
                    )}
                </div>
            </div>
        </div>
    );
});

/**
 * 命令行的 Tag 已展示 `/{name}`，正文只保留其后的参数，避免同一命令行在气泡里重复出现
 * （落库的用户消息 parts 同时含原文 text 与 data-command）。名称对不上时原样返回，不吞用户文本。
 */
function textAfterCommand(text: string, name: string): string {
    const trimmed = text.trimStart();
    const head = `/${name}`;
    if (!trimmed.startsWith(head)) return text;
    const rest = trimmed.slice(head.length);
    // `/${name}xxx` 不是同一条命令（与输入框解析口径一致：命令名后必须空白或结束）
    if (rest && !/^\s/.test(rest)) return text;
    return rest.trim();
}

function renderUserParts(message: UIMessage, popoverClass: string): ReactNode {
    const text = message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    const files = message.parts.filter((part) => part.type === 'file');
    // slash 命令：用可查看展开内容的 Tag 承载命令行，正文只渲染命令之外的参数
    const command = message.parts.find((part) => part.type === 'data-command') as
        { data?: Partial<CommandPartData> } | undefined;
    const nodes: ReactNode[] = [];
    if (command?.data?.name) {
        nodes.push(
            <Popover
                key="command"
                classNames={{ root: popoverClass }}
                title="命令展开内容"
                content={<pre className="message-item-command-expanded">{command.data.expanded ?? ''}</pre>}
            >
                <Tag className="message-item-command-tag" icon={<ThunderboltOutlined />}>
                    /{command.data.name}
                </Tag>
            </Popover>
        );
    }
    if (files.length > 0) {
        nodes.push(
            <div key="attachments" className="message-item-attachments">
                {files.map((part, i) => renderFilePart(part, `file-${i}`))}
            </div>
        );
    }
    const bodyText = command?.data?.name ? textAfterCommand(text, command.data.name) : text;
    if (bodyText) nodes.push(<span key="text">{bodyText}</span>);
    return nodes;
}

function renderAssistantParts(
    nodes: ReturnType<typeof buildTimeline>,
    messageId: string,
    streaming: boolean,
    cursorClass: string,
    actions: ReturnType<typeof useChatActions>,
    conversationId: string,
    pendingQuestionIds: ReadonlySet<string>
): ReactNode {
    const rendered: ReactNode[] = [];
    let hasVisibleContent = false;

    nodes.forEach((node, index) => {
        if (node.kind === 'text') {
            hasVisibleContent = true;
            // openLinksInNewTab：正文链接统一加 target="_blank"。web 下开新标签页；Electron 下经 window.open
            // 命中主进程 setWindowOpenHandler → shell.openExternal 用系统默认浏览器打开，避免替换当前应用地址。
            // StreamingMarkdown：按顶层块切分逐块渲染，已完成的块被 memo 冻结，流式中只重算末尾一块。
            // 只有「消息仍在流式 且 该 text 是最后一个节点」才算增长中，末尾块才开 XMarkdown 的流式缓存。
            rendered.push(
                <StreamingMarkdown
                    key={node.key}
                    text={node.part.text}
                    streaming={streaming && index === nodes.length - 1}
                />
            );
            return;
        }
        if (node.kind === 'reasoning') {
            hasVisibleContent = true;
            rendered.push(<ThinkingBlock key={node.key} text={node.part.text} done={node.part.state === 'done'} />);
            return;
        }
        if (node.kind === 'file') {
            hasVisibleContent = true;
            rendered.push(
                <div key={node.key} className="message-item-attachments">
                    {renderFilePart(node.part, `file-inner-${node.key}`)}
                </div>
            );
            return;
        }
        if (node.kind === 'question') {
            hasVisibleContent = true;
            rendered.push(
                <AskQuestionCard
                    key={node.key}
                    conversationId={conversationId}
                    messageId={messageId}
                    canAnswer={pendingQuestionIds.has(node.part.toolCallId)}
                    toolCallId={node.part.toolCallId}
                    state={node.part.state}
                    input={'input' in node.part ? node.part.input : undefined}
                    output={'output' in node.part ? node.part.output : undefined}
                    onAnswer={actions.answerQuestion}
                />
            );
            return;
        }
        if (node.kind === 'task') {
            hasVisibleContent = true;
            rendered.push(
                <TaskListCard
                    key={node.key}
                    toolName={getToolName(node.part)}
                    state={node.part.state}
                    output={'output' in node.part ? node.part.output : undefined}
                    errorText={'errorText' in node.part ? node.part.errorText : undefined}
                />
            );
            return;
        }

        hasVisibleContent = true;
        // 首个工具出现时就挂载分组，流式追加第二个工具时保留用户的展开态。
        rendered.push(<ActivityGroup key={node.key} items={node.items} />);
    });

    if (streaming) {
        rendered.push(<span key="cursor" className={cursorClass} />);
    } else if (!hasVisibleContent) {
        // 空的 assistant 消息（如出错且无任何输出）不留空白气泡
        return null;
    }

    return rendered;
}

export default MessageRow;
