import type { CompactionMetadata } from '@zhuixun/shared';
import { Fragment } from 'react';

import { useChatMessages, useChatRun } from '../chat-context';
import { CompactionDivider } from '../CompactionDivider';
import { MessageRow } from '../MessageItem';

import useStyles from './styles';

/**
 * 消息列表：`ChatMessagesContext` 的主要消费方。
 *
 * 随 token 重渲染是预期内的——每次更新只是 map 一遍消息并为每行生成相同 props 的 element，
 * 真正的渲染工作由 `MessageRow` 的 memo 拦下（历史消息对象引用稳定）。
 */
export function MessageList() {
    const { styles, cx } = useStyles();
    const messages = useChatMessages();
    const { loading: isStreaming, pendingInteractionCount } = useChatRun();

    if (messages.length === 0) {
        return (
            <section className={cx('message-list-placeholder', styles.toString())} aria-labelledby="chat-welcome">
                <h1 id="chat-welcome">沿着自己的路追寻</h1>
                <p>心里还有什么没想明白，就从那里开始。</p>
            </section>
        );
    }

    return (
        <div className={cx('message-list', styles.toString())}>
            {messages.map((message, index) => {
                // 只对列表中最后一条 assistant 消息展示流式光标
                const isLast = index === messages.length - 1;
                const streaming = isStreaming && isLast && message.role === 'assistant';
                // 本轮若触发过上下文压缩，metadata.compaction 存在：在该消息前渲染「上下文已压缩」分隔条
                const meta = message.metadata as CompactionMetadata | undefined;
                const compaction = meta?.compaction;
                // /compact 手动压缩：标记挂在压缩时最后一条回复上，分隔条渲染在其之后
                const manualCompaction = meta?.manualCompaction;
                return (
                    <Fragment key={message.id}>
                        {compaction && <CompactionDivider marker={compaction} />}
                        <MessageRow
                            message={message}
                            streaming={streaming}
                            isLast={isLast}
                            // 停止提示的按钮只在最后一条上出现，其余行固定 false，避免 status 变化让历史行重渲染
                            busy={isLast && (isStreaming || pendingInteractionCount > 0)}
                        />
                        {manualCompaction && <CompactionDivider marker={manualCompaction} manual />}
                    </Fragment>
                );
            })}
        </div>
    );
}
