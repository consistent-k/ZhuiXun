/** workspace 公开面：会话摘要与文件引用独立于聊天镜像保存，文件引用从不作为授权。 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Task, WorkspaceFileReference } from '@zhuixun/shared';
import { tool, type TextStreamPart, type ToolSet } from 'ai';
import { z } from 'zod';

import { paths } from '@/config/paths';

import { inspectFile, WorkspaceError } from './files';
import { readWorkspace, updateWorkspace } from './store';

export {
    approveFile,
    inspectFile,
    readFileContent,
    resolveFile,
    createFileDownload,
    consumeFileDownload,
    WorkspaceError
} from './files';
export { beginWorkspace, pruneWorkspace, readWorkspace, subscribeWorkspace, updateWorkspace } from './store';

const identityLoads = new Map<string, Promise<{ workspaceInstanceId: string }>>();

/** 稳定数据集 UUID；同进程并发初始化共用一个任务，避免读到尚未写完的身份。 */
export function workspaceIdentity() {
    const file = paths.workspaceIdentityFile();
    let pending = identityLoads.get(file);
    if (!pending) {
        pending = loadIdentity(file);
        identityLoads.set(file, pending);
        void pending.catch(() => identityLoads.delete(file));
    }
    return pending;
}
async function loadIdentity(file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
        await fs.writeFile(file, randomUUID(), { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const id = (await fs.readFile(file, 'utf8')).trim();
    if (!z.uuid().safeParse(id).success) throw new Error('工作区身份文件损坏');
    return { workspaceInstanceId: id };
}

/** 两种主 agent 共用显式交付登记；工具本身不读取文件正文。 */
export function createWorkspaceTools(sessionId?: string, turnId?: string): ToolSet {
    if (!sessionId || !turnId) return {};
    return {
        register_artifact: tool({
            description:
                '将本轮生成的交付文件（报告、图片、PDF 等）登记到会话产物列表。普通源码修改与临时脚本不要登记。先完成文件写入，再传实际文件路径；登记不授予读取权限。',
            inputSchema: z.object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(200).optional() }),
            execute: async ({ path: file, name }) => {
                const reference: WorkspaceFileReference = {
                    kind: 'workspace',
                    path: file,
                    name: name ?? path.basename(file),
                    turnId
                };
                try {
                    const info = await inspectFile(sessionId, reference);
                    const normalized = { ...reference, path: info.real };
                    await updateWorkspace(sessionId, turnId, (turn) => {
                        if (!turn.summary.artifacts.some((a) => a.kind === 'workspace' && a.path === normalized.path))
                            turn.summary.artifacts.push(normalized);
                    });
                    return { ok: true, artifact: normalized };
                } catch (error) {
                    if (error instanceof WorkspaceError) return { ok: false, error: error.message };
                    throw error;
                }
            }
        })
    };
}

/** 只观察结构化成功输出，不猜测 Bash stdout；异步调用者需顺序 await。 */
export async function observeWorkspacePart(id: string, turnId: string, part: TextStreamPart<ToolSet>) {
    if (part.type === 'source' && part.sourceType === 'url' && /^https?:\/\//i.test(part.url)) {
        await updateWorkspace(id, turnId, (turn) => {
            if (!turn.summary.sources.some((s) => s.url === part.url))
                turn.summary.sources.push({ id: part.id, name: part.title ?? part.url, url: part.url });
        });
    }
    if (part.type !== 'tool-result') return;
    const output = part.output as Record<string, unknown> | undefined;
    if (output?.ok === false) return;
    const input = part.input as Record<string, unknown> | undefined;
    const task = ['TaskCreate', 'TaskUpdate', 'TaskList'].includes(part.toolName);
    const file =
        ['Read', 'Write', 'Edit'].includes(part.toolName) && typeof (input?.path ?? input?.file_path) === 'string'
            ? String(input?.path ?? input?.file_path)
            : undefined;
    const url = part.toolName === 'WebFetch' && typeof input?.url === 'string' ? input.url : undefined;
    if (!task && !file && !url) return;
    await updateWorkspace(id, turnId, (turn) => {
        if (task && Array.isArray(output?.tasks)) turn.summary.tasks = output.tasks as Task[];
        if (file) {
            const absolute = path.resolve(turn.cwd, file);
            if (!turn.files.includes(absolute)) turn.files.push(absolute);
            if (part.toolName === 'Read') {
                if (!turn.summary.sources.some((s) => s.id === absolute))
                    turn.summary.sources.push({
                        id: absolute,
                        name: path.basename(absolute),
                        file: { kind: 'workspace', path: absolute, name: path.basename(absolute), turnId }
                    });
            } else turn.summary.changedPaths.push(absolute);
        }
        if (url && /^https?:\/\//i.test(url) && !turn.summary.sources.some((s) => s.url === url))
            turn.summary.sources.push({ id: url, name: url, url });
    });
}

/** 服务端快照对账：过滤已经被回滚/重新生成移除的轮次。 */
export async function workspaceSummaries(id: string, validTurns: Set<string>) {
    return (await readWorkspace(id)).turns.filter((t) => validTurns.has(t.summary.turnId)).map((t) => t.summary);
}
