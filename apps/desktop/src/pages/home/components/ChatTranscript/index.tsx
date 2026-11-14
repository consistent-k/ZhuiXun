import { DownOutlined, LoadingOutlined } from '@ant-design/icons';
import { Button, Spin } from 'antd';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';

import { useChatMessages, useChatRun } from '../chat-context';
import { ChatScrollContext, type ChatScrollControl } from '../chat-scroll-context';
import { MessageList } from '../MessageList';

import useStyles from './styles';

interface ChatTranscriptProps {
    /** 会话切换时用于把视图重置到底部 */
    conversationKey?: string;
    /** 切换会话时异步拉取历史消息中的 loading 态 */
    messagesLoading?: boolean;
}

/**
 * 消息滚动区：滚动容器 + 贴底跟随 + 消息列表。
 *
 * 贴底改用 `use-stick-to-bottom` 的弹簧追底：流式内容高度是离散增长的（一次换行、一行表格），
 * 旧实现每次增高直接写 `scrollTop = scrollHeight`，视觉上是「静止 → 硬跳几十像素 → 静止」。
 * 弹簧动画让目标位置随内容实时更新、位置连续逼近，观感是持续滚动。
 *
 * 库内部用 ResizeObserver 监听内容高度，自行区分「用户滚动」与「程序滚动」（记录自己写入的
 * scrollTop 并跳过对应事件），用户上滚立即解除跟随、拖选正文时不打断。
 *
 * 本组件消费 `ChatMessagesContext`，随 token 重渲染——贴底逻辑本来就需要感知消息变化；
 * 它渲染的子树只有消息列表与两个瞬时提示，标题栏、输入框等同级 UI 不受影响。
 */
export function ChatTranscript({ conversationKey, messagesLoading }: ChatTranscriptProps) {
    const { styles, cx } = useStyles();
    const messages = useChatMessages();
    const { isCompacting, retrying } = useChatRun();

    const { scrollRef, contentRef, scrollToBottom, stopScroll, isAtBottom } = useStickToBottom({
        // 首帧直接落在最新一条，不要从顶部滑下来
        initial: 'instant',
        // 流式增长、高度变化时平滑追底
        resize: 'smooth'
    });

    // 切换会话：内容整体替换，直接落到底部（平滑会从旧位置缓缓滚过来）
    useLayoutEffect(() => {
        void scrollToBottom('instant');
    }, [conversationKey, scrollToBottom]);

    // 发出新消息：无论当时是否在上方看历史，都回到底部开始看回复
    const lastMessage = messages[messages.length - 1];
    useEffect(() => {
        if (lastMessage?.role === 'user') void scrollToBottom('instant');
    }, [lastMessage?.id, lastMessage?.role, scrollToBottom]);

    const scrollControl = useMemo<ChatScrollControl>(() => ({ stopScroll }), [stopScroll]);

    return (
        <div className={cx('chat-transcript', styles.toString())}>
            <div className="chat-transcript-scroll" ref={scrollRef}>
                <div className="chat-transcript-inner" ref={contentRef}>
                    {messagesLoading ? (
                        <div className="chat-transcript-loading">
                            <Spin />
                        </div>
                    ) : (
                        <ChatScrollContext.Provider value={scrollControl}>
                            <MessageList />
                        </ChatScrollContext.Provider>
                    )}
                    {isCompacting && (
                        <div className="chat-transcript-notice">
                            <LoadingOutlined spin />
                            <span>正在压缩上下文…</span>
                        </div>
                    )}
                    {retrying && (
                        <div className="chat-transcript-notice">
                            <LoadingOutlined spin />
                            <span>
                                模型服务繁忙，正在重试（{retrying.attempt}/{retrying.max}）…
                            </span>
                        </div>
                    )}
                </div>
            </div>
            {!isAtBottom && (
                <Button
                    className="chat-transcript-back-bottom"
                    shape="circle"
                    size="small"
                    icon={<DownOutlined />}
                    onClick={() => void scrollToBottom()}
                    aria-label="回到底部"
                    title="回到底部"
                />
            )}
        </div>
    );
}

export default ChatTranscript;
