import type { Task } from './task';

/** 文件引用只定位资源，不授予读取权限。 */
export type WorkspaceFileReference =
    | { kind: 'attachment'; attachmentId: string; name: string; turnId?: string }
    | { kind: 'workspace'; path: string; name: string; turnId?: string; line?: number };

/** 后端持久化并广播的单轮摘要。 */
export interface WorkspaceSummary {
    conversationId: string;
    turnId: string;
    revision: number;
    status: 'running' | 'waiting' | 'completed' | 'stopped' | 'failed';
    tasks: Task[];
    sources: { id: string; name: string; url?: string; file?: WorkspaceFileReference }[];
    artifacts: WorkspaceFileReference[];
    changedPaths: string[];
}

/** 解析后的文件描述；fileId 在服务端重启后失效。 */
export interface WorkspaceFileView {
    fileId: string;
    resourceKey: string;
    reference: WorkspaceFileReference;
    name: string;
    size: number;
    version: string;
    mediaType: string;
    preview: 'text' | 'markdown' | 'image' | 'pdf' | 'unsupported';
    limit: number;
    tooLarge: boolean;
    approvalRequired: boolean;
}
