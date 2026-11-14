import fs from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from '@/config/atomic-json';
import { createLogger } from '@/platform/logging/index';

import { parseMemoryRecord, serializeMemoryRecord } from './frontmatter';
import { buildIndexContent, indexPath, readIndex } from './index-file';
import { invalidateManifest, scanManifest } from './manifest';
import { sanitizeMemoryName } from './scope';
import type { MemoryManifestItem, MemoryRecord, MemoryType } from './types';

const log = createLogger('Memory');

export interface WriteMemoryInput {
    name: string;
    type: MemoryType;
    description: string;
    content: string;
    originSessionId?: string;
}

export interface WriteMemoryResult {
    record: MemoryRecord;
    /** 写入前是否已存在同名条目：false 表示这次是「新建」而非「覆盖」。 */
    created: boolean;
}

/**
 * 单层记忆存储（一个记忆根一实例）：多文件 CRUD + 索引重建 + 串行队列 + 原子写（临时文件 rename）。
 * 索引在每次写/删后由清单确定性重建，杜绝漂移。
 */
export class MemoryStore {
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly root: string) {}

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private filePath(name: string): string {
        return path.join(this.root, `${name}.md`);
    }

    /** 列出清单（供设置页与召回）。 */
    list(): Promise<MemoryManifestItem[]> {
        return scanManifest(this.root);
    }

    /** 读单条记录；不存在或名称非法返回 null。 */
    async read(name: string): Promise<MemoryRecord | null> {
        const slug = sanitizeMemoryName(name);
        if (!slug) return null;
        try {
            return parseMemoryRecord(await fs.readFile(this.filePath(slug), 'utf8'), slug);
        } catch {
            return null;
        }
    }

    /** 读当前层索引正文。 */
    readIndex(): Promise<string> {
        return readIndex(this.root);
    }

    /**
     * 新建或按 name 覆盖一条记忆，并重建索引。名称非法抛错。
     * 返回值带 created 标记：调用方（尤其 write_memory 工具）需要据此区分「新建」与「覆盖」，
     * 避免模型把幻觉出的记忆名当成既有条目的「更新」而静默沉淀成新事实。
     */
    async write(input: WriteMemoryInput): Promise<WriteMemoryResult> {
        const slug = sanitizeMemoryName(input.name);
        if (!slug) throw new Error('非法的记忆名称');
        const record: MemoryRecord = {
            name: slug,
            type: input.type,
            description: input.description.trim(),
            content: input.content.trim(),
            updatedAt: new Date().toISOString(),
            originSessionId: input.originSessionId
        };
        return this.enqueue(async () => {
            // 存在性探测放在串行队列内，与本次写入同队列，避免并发下 created 判定错位。
            const created = await fs
                .access(this.filePath(slug))
                .then(() => false)
                .catch(() => true);
            await fs.mkdir(this.root, { recursive: true });
            await this.atomicWrite(this.filePath(slug), serializeMemoryRecord(record));
            await this.rebuildIndex();
            invalidateManifest(this.root);
            return { record, created };
        });
    }

    /** 删一条记忆并重建索引；文件不存在返回 false。 */
    async delete(name: string): Promise<boolean> {
        const slug = sanitizeMemoryName(name);
        if (!slug) return false;
        return this.enqueue(async () => {
            try {
                await fs.unlink(this.filePath(slug));
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    log.error('删除记忆失败', { slug, err });
                }
                return false;
            }
            await this.rebuildIndex();
            invalidateManifest(this.root);
            return true;
        });
    }

    /** 直接整体改索引（设置页手动编辑）。 */
    async writeIndex(content: string): Promise<void> {
        return this.enqueue(async () => {
            await fs.mkdir(this.root, { recursive: true });
            await this.atomicWrite(indexPath(this.root), `${content.trim()}\n`);
        });
    }

    private async rebuildIndex(): Promise<void> {
        invalidateManifest(this.root);
        const items = await scanManifest(this.root);
        await this.atomicWrite(indexPath(this.root), buildIndexContent(items));
    }

    /** 原子写委托给 platform/fs（唯一实现）；并发串行化仍由本 store 的 enqueue 负责。 */
    private atomicWrite(file: string, data: string): Promise<void> {
        return writeFileAtomic(file, data);
    }
}

// ---------------- store 工厂（按根缓存实例） ----------------

const stores = new Map<string, MemoryStore>();

/** 按记忆根取 store 单例（根路径由 scope.ts 解析）。 */
export function getMemoryStore(root: string): MemoryStore {
    let store = stores.get(root);
    if (!store) {
        store = new MemoryStore(root);
        stores.set(root, store);
    }
    return store;
}
