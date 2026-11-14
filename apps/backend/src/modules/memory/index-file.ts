import fs from 'node:fs/promises';
import path from 'node:path';

import type { MemoryManifestItem } from './types';

export const MEMORY_INDEX_FILE = 'MEMORY.md';

export function indexPath(root: string): string {
    return path.join(root, MEMORY_INDEX_FILE);
}

/** 从清单确定性重建索引正文（每条一行指针），避免与实际文件漂移。 */
export function buildIndexContent(items: readonly MemoryManifestItem[]): string {
    if (items.length === 0) return '# Memory\n';
    const lines = items.map((it) => {
        const type = it.type ? ` [${it.type}]` : '';
        const desc = it.description ? ` — ${it.description}` : '';
        return `- [${it.name}](${it.name}.md)${type}${desc}`;
    });
    return `# Memory\n\n${lines.join('\n')}\n`;
}

/** 读索引正文；不存在返回空串。 */
export async function readIndex(root: string): Promise<string> {
    try {
        return (await fs.readFile(indexPath(root), 'utf8')).trim();
    } catch {
        return '';
    }
}
