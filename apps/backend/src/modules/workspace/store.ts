import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceSummary } from '@zhuixun/shared';

import { paths } from '@/config/paths';
import { isValidConversationId } from '@/modules/conversations';

interface WorkspaceTurn {
    summary: WorkspaceSummary;
    cwd: string;
    roots: string[];
    /** 共享临时根不授予整根读取；只允许本轮工具确认触碰过的文件。 */
    temporary: boolean;
    files: string[];
}
interface WorkspaceState {
    version: 1;
    turns: WorkspaceTurn[];
}
const queues = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<(summary: WorkspaceSummary) => void>>();

function statePath(id: string): string {
    if (!isValidConversationId(id)) throw new Error('非法会话 id');
    return path.join(paths.sessionsDir(), id, 'workspace.json');
}

/** 只读会话附属快照；不把读取错误当作空数据覆盖。 */
export async function readWorkspace(id: string): Promise<WorkspaceState> {
    try {
        const state = JSON.parse(await fs.readFile(statePath(id), 'utf8')) as WorkspaceState;
        if (state.version !== 1 || !Array.isArray(state.turns)) throw new Error('工作区快照格式不正确');
        return state;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, turns: [] };
        throw error;
    }
}

/** 每会话串行读改写，rename 成功后才发布，防止旧快照覆盖新工具结果。 */
export function mutateWorkspace(id: string, mutate: (state: WorkspaceState) => void): Promise<void> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(async () => {
            const state = await readWorkspace(id);
            mutate(state);
            const file = statePath(id);
            await fs.mkdir(path.dirname(file), { recursive: true });
            const temp = `${file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
                await fs.rename(temp, file);
            } finally {
                await fs.rm(temp, { force: true });
            }
        });
    queues.set(id, next);
    void next
        .finally(() => {
            if (queues.get(id) === next) queues.delete(id);
        })
        .catch(() => undefined);
    return next;
}

/** 建立轮次上下文；审批续跑不重置已有摘要。 */
export async function beginWorkspace(id: string, turnId: string, cwd: string, roots: string[], temporary: boolean) {
    await mutateWorkspace(id, (state) => {
        const existing = state.turns.find((t) => t.summary.turnId === turnId);
        if (existing) {
            existing.summary.status = 'running';
            existing.summary.revision++;
            return;
        }
        state.turns.push({
            cwd,
            roots,
            temporary,
            files: [],
            summary: {
                conversationId: id,
                turnId,
                revision: 1,
                status: 'running',
                tasks: [],
                sources: [],
                artifacts: [],
                changedPaths: []
            }
        });
    });
}

/** 发布服务端摘要，不允许监听器故障中断会话落盘。 */
export async function updateWorkspace(id: string, turnId: string, update: (turn: WorkspaceTurn) => void) {
    let published: WorkspaceSummary | undefined;
    await mutateWorkspace(id, (state) => {
        const turn = state.turns.find((t) => t.summary.turnId === turnId);
        if (!turn) return;
        update(turn);
        turn.summary.revision++;
        published = structuredClone(turn.summary);
    });
    if (published)
        for (const listener of listeners.get(id) ?? []) {
            try {
                listener(published);
            } catch {
                /* 已结束流的监听器不能阻断业务落盘。 */
            }
        }
}

/** 本轮摘要监听，解绑后不再向已结束的消息流写入。 */
export function subscribeWorkspace(id: string, listener: (summary: WorkspaceSummary) => void) {
    const set = listeners.get(id) ?? new Set();
    set.add(listener);
    listeners.set(id, set);
    return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(id);
    };
}

/** 回滚/重新生成后移除已不存在用户轮的摘要。 */
export async function pruneWorkspace(id: string, turnIds: string[]) {
    await mutateWorkspace(id, (state) => {
        state.turns = state.turns.filter((t) => turnIds.includes(t.summary.turnId));
    });
}
