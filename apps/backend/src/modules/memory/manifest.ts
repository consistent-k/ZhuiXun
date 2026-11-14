import fs from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from '@/platform/logging/index';

import { readManifestFields } from './frontmatter';
import { MEMORY_INDEX_FILE } from './index-file';
import type { MemoryManifestItem } from './types';

const log = createLogger('Memory');
const MANIFEST_FILE_CAP = 200;
const PREVIEW_BYTES = 4096;

interface CacheEntry {
    items: MemoryManifestItem[];
    dirMtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

/** 写/删后失效某根清单缓存。 */
export function invalidateManifest(root: string): void {
    cache.delete(root);
}

async function dirMtime(root: string): Promise<number> {
    try {
        return (await fs.stat(root)).mtimeMs;
    } catch {
        return -1;
    }
}

/** 扫描某记忆根，读各 .md 的 frontmatter 生成清单（按 mtime 降序，封顶 200）。带目录 mtime 缓存。 */
export async function scanManifest(root: string): Promise<MemoryManifestItem[]> {
    const mtime = await dirMtime(root);
    const cached = cache.get(root);
    if (cached && cached.dirMtimeMs === mtime) return cached.items;

    let files: string[];
    try {
        files = (await fs.readdir(root)).filter((f) => f.endsWith('.md') && f !== MEMORY_INDEX_FILE);
    } catch {
        return [];
    }

    const items: MemoryManifestItem[] = [];
    for (const file of files) {
        const full = path.join(root, file);
        try {
            const [stat, buf] = await Promise.all([fs.stat(full), fs.readFile(full, 'utf8')]);
            const fm = readManifestFields(buf.slice(0, PREVIEW_BYTES));
            items.push({
                name: file.replace(/\.md$/u, ''),
                type: fm.type,
                description: fm.description,
                updatedAt: fm.updatedAt ?? new Date(stat.mtimeMs).toISOString(),
                mtimeMs: stat.mtimeMs
            });
        } catch (err) {
            log.warn('读取记忆清单项失败，跳过', { file, err });
        }
    }

    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const capped = items.slice(0, MANIFEST_FILE_CAP);
    cache.set(root, { items: capped, dirMtimeMs: mtime });
    return capped;
}
