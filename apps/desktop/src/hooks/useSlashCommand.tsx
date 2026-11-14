import type { CommandPartData, CommandSummary } from '@zhuixun/shared';
import { App } from 'antd';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';

import { SUCCESS_CODE } from '@/constant/code';
import { compactConversationApi, expandCommandApi, fetchCommandsApi, type UploadedAttachment } from '@/services';
import { useChatStore } from '@/stores';
import { chatRegistry } from '@/stores/chatRegistry';

type SendFn = (content: string, attachments?: UploadedAttachment[], command?: CommandPartData) => Promise<void>;

/** 与后端 `parseCommandInvocation` 同口径：`/name` 后接空白或结束；`/path/to/file` 不算命令。 */
const COMMAND_RE = /^\/([a-z0-9][a-z0-9-]{0,31})(?=\s|$)([\s\S]*)$/;

export function parseSlashCommand(text: string): { name: string; args: string } | null {
    const match = COMMAND_RE.exec(text.trimStart());
    return match ? { name: match[1], args: match[2].trim() } : null;
}

function commandLine(c: CommandSummary): string {
    return `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}${c.description ? ` —— ${c.description}` : ''}`;
}

/**
 * 输入框 slash 命令处理：内置 `/new` `/help` `/compact` 本地执行；用户命令发送前经后端展开，
 * 原文 + `data-command` 展开快照一起发送；未命中命令按普通文本发送（用户可能真的想发 `/path/to/file`）。
 */
export function useSlashCommand(send: SendFn) {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();

    const runCompact = useCallback(
        async (instructions: string) => {
            const store = useChatStore.getState();
            const convId = store.currentConversationId;
            // 未落库的草稿会话没有可压缩的历史
            if (!convId || !store.conversations.some((c) => c.id === convId)) {
                message.info('当前对话还没有可压缩的内容');
                return;
            }
            const status = chatRegistry.acquire(convId).status;
            if (status === 'streaming' || status === 'submitted') {
                message.warning('正在生成回复，请稍后再压缩');
                return;
            }
            store.setCompacting(convId, true);
            try {
                const res = await compactConversationApi(convId, instructions || undefined);
                if (res.code !== SUCCESS_CODE || !res.data) return;
                if (!res.data.changed) {
                    message.info('当前上下文无需压缩');
                    return;
                }
                // 后端已把标记写入最后一条回复的 metadata：重拉消息即可渲染分隔条
                await chatRegistry.reloadConversation(convId);
                message.success('上下文已压缩，下一轮对话将使用摘要');
            } finally {
                useChatStore.getState().setCompacting(convId, false);
            }
        },
        [message]
    );

    const showHelp = useCallback(async () => {
        const res = await fetchCommandsApi();
        const data = res.code === SUCCESS_CODE ? res.data : undefined;
        const lines = [
            ...(data?.builtin ?? []).map(commandLine),
            ...(data?.user.length ? data.user.map(commandLine) : ['（暂无自定义命令，可在「设置 → 命令」中新建）'])
        ];
        modal.info({
            title: '可用命令',
            width: 560,
            content: (
                <ul style={{ paddingLeft: 16, margin: 0 }}>
                    {lines.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            )
        });
    }, [modal]);

    return useCallback(
        async (text: string, attachments: UploadedAttachment[] = []) => {
            const invocation = parseSlashCommand(text);
            if (!invocation) return send(text, attachments);
            if (invocation.name === 'new') {
                navigate(`/chat/${crypto.randomUUID()}`);
                return;
            }
            if (invocation.name === 'help') return showHelp();
            if (invocation.name === 'compact') return runCompact(invocation.args);
            const res = await expandCommandApi(text);
            const result = res.code === SUCCESS_CODE ? res.data : undefined;
            if (result?.matched && result.name && result.expanded !== undefined) {
                return send(text, attachments, {
                    name: result.name,
                    args: result.args ?? '',
                    expanded: result.expanded
                });
            }
            return send(text, attachments);
        },
        [send, navigate, showHelp, runCompact]
    );
}
