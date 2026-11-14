import { createLogger } from '@/platform/logging/index';

import { resolveMemoryRoot } from './scope';
import { getMemoryStore } from './store';
import type { MemoryType } from './types';
import { isMemoryScope, isMemoryType, type MemoryScope } from './types';

const log = createLogger('Memory');

export interface MemoryWriteOp {
    action: 'write';
    scope: MemoryScope;
    name: string;
    type: MemoryType;
    description: string;
    content: string;
}
export interface MemoryDeleteOp {
    action: 'delete';
    scope: MemoryScope;
    name: string;
}
export type MemoryOp = MemoryWriteOp | MemoryDeleteOp;

function coerceScope(value: unknown, hasProject: boolean): MemoryScope {
    if (isMemoryScope(value)) return value === 'project' && !hasProject ? 'global' : value;
    return 'global';
}

/** 容错解析模型返回的记忆操作 JSON（允许前后夹带说明文字，截取首个数组）。 */
export function parseMemoryOps(text: string, hasProject: boolean): MemoryOp[] {
    const match = text.match(/\[[\s\S]*\]/u);
    if (!match) return [];
    let arr: unknown;
    try {
        arr = JSON.parse(match[0]);
    } catch {
        return [];
    }
    if (!Array.isArray(arr)) return [];

    const ops: MemoryOp[] = [];
    for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue;
        const o = raw as Record<string, unknown>;
        const name = typeof o.name === 'string' ? o.name : '';
        if (!name) continue;
        const scope = coerceScope(o.scope, hasProject);
        if (o.action === 'delete') {
            ops.push({ action: 'delete', scope, name });
            continue;
        }
        if ((o.action === 'write' || o.action === undefined) && isMemoryType(o.type)) {
            ops.push({
                action: 'write',
                scope,
                name,
                type: o.type,
                description: typeof o.description === 'string' ? o.description : '',
                content: typeof o.content === 'string' ? o.content : ''
            });
        }
    }
    return ops;
}

export interface ApplyResult {
    written: number;
    deleted: number;
}

/** 应用一批记忆操作（写/删）到对应层 store；单条失败不影响其余。 */
export async function applyMemoryOps(
    ops: readonly MemoryOp[],
    ctx: { projectId?: string; sessionId?: string }
): Promise<ApplyResult> {
    let written = 0;
    let deleted = 0;
    for (const op of ops) {
        const store = getMemoryStore(resolveMemoryRoot(op.scope, ctx.projectId));
        try {
            if (op.action === 'write') {
                if (!op.content.trim()) continue;
                await store.write({
                    name: op.name,
                    type: op.type,
                    description: op.description,
                    content: op.content,
                    originSessionId: ctx.sessionId
                });
                written++;
            } else if (await store.delete(op.name)) {
                deleted++;
            }
        } catch (err) {
            log.warn('应用记忆操作失败，跳过', { op, err });
        }
    }
    return { written, deleted };
}
