import { EyeOutlined, FileTextOutlined } from '@ant-design/icons';
import type { ComponentProps } from '@ant-design/x-markdown';
import type { WorkspaceFileReference } from '@zhuixun/shared';
import { App, Button } from 'antd';
import { useContext, useRef, useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { resolveWorkspaceFileApi } from '@/services/workspace';
import { useChatStore } from '@/stores';
import { useWorkspacePanelStore } from '@/stores/workspacePanelStore';

import { beginFileOpen, isCurrentFileOpen } from './file-opening';
import { FileTurnContext, parseFileReference } from './file-reference';

/** 文件入口先解析合法身份，打开标签后由预览器处理读取确认。 */
export function FileReference({
    reference,
    children
}: {
    reference: WorkspaceFileReference;
    children?: React.ReactNode;
}) {
    const id = useChatStore((state) => state.currentConversationId);
    const turnId = useContext(FileTurnContext);
    const { message } = App.useApp();
    const [loading, setLoading] = useState(false);
    const generation = useRef(0);
    const open = async () => {
        if (!id || loading) return;
        const request = ++generation.current;
        const operation = beginFileOpen(id);
        setLoading(true);
        try {
            await useWorkspacePanelStore.getState().initialize();
            const ref = { ...reference, turnId: reference.turnId ?? turnId };
            const result = await resolveWorkspaceFileApi(id, ref);
            if (
                request !== generation.current ||
                !isCurrentFileOpen(id, operation) ||
                useChatStore.getState().currentConversationId !== id
            )
                return;
            if (result.code !== SUCCESS_CODE || !result.data) {
                message.error(result.message ?? '无法预览');
                return;
            }
            if (!useWorkspacePanelStore.getState().instance) {
                message.error('工作区身份不可用，请重试');
                return;
            }
            useWorkspacePanelStore
                .getState()
                .openFile(
                    id,
                    { ...ref, name: reference.name === '附件' ? result.data.name : ref.name },
                    result.data.resourceKey
                );
        } finally {
            setLoading(false);
        }
    };
    return (
        <span className="workspace-file-reference">
            <FileTextOutlined /> <span>{children ?? reference.name}</span>
            <Button
                type="text"
                size="small"
                icon={<EyeOutlined />}
                loading={loading}
                aria-label={`预览 ${reference.name}`}
                onClick={() => void open()}
            />
        </span>
    );
}

/** XMarkdown 的稳定组件映射保留普通链接默认行为。 */
export function FileLink(props: ComponentProps) {
    const turnId = useContext(FileTurnContext);
    const href = typeof props.href === 'string' ? props.href : '';
    const ref = parseFileReference(href, turnId);
    if (ref) return <FileReference reference={ref}>{props.children}</FileReference>;
    return (
        <a href={href} target="_blank" rel="noreferrer">
            {props.children}
        </a>
    );
}
