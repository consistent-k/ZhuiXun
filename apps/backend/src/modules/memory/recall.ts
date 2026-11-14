import fs from 'node:fs/promises';
import path from 'node:path';

import type { LanguageModel } from 'ai';

import type { ResolvedModel } from '@/config/types';

import { splitFrontmatter } from './frontmatter';
import { scanManifest } from './manifest';
import { resolveMemoryRoot } from './scope';
import { memoryItemId, selectRelevantMemories, type TaggedManifestItem } from './selector';
import type { MemoryScope } from './types';

const PER_FILE_BYTE_LIMIT = 4096;
const PER_FILE_LINE_LIMIT = 200;
const SESSION_RECALL_BUDGET = 32_768;
/** 两层条目总数不超过此值时跳过选择器、直接全量注入（省一次 LLM 调用）。 */
const FAST_PATH_MAX_ITEMS = 8;
const STALE_DAY_MS = 86_400_000;

export interface RecallLayer {
    scope: MemoryScope;
    projectId?: string;
}

interface SelectedFile {
    name: string;
    root: string;
    mtimeMs: number;
}

function staleHeader(name: string, mtimeMs: number, nowMs: number): string {
    const days = Math.max(0, Math.floor((nowMs - mtimeMs) / STALE_DAY_MS));
    if (days <= 1) return `记忆 ${name}:`;
    return `这条记忆是 ${days} 天前写的，可能已过期，断言前请先核实当前代码/事实。\n记忆 ${name}:`;
}

function limitContent(raw: string): string {
    let out = raw.replace(/\r\n/gu, '\n').split('\n').slice(0, PER_FILE_LINE_LIMIT).join('\n');
    if (Buffer.byteLength(out, 'utf8') > PER_FILE_BYTE_LIMIT) {
        out = Buffer.from(out, 'utf8').subarray(0, PER_FILE_BYTE_LIMIT).toString('utf8');
    }
    return out.trim();
}

/** 跨层召回：按当前问题挑相关记忆，返回可直接注入的正文段（含陈旧度头）；无命中返回 ''。 */
export async function recallMemories(input: {
    query: string;
    layers: readonly RecallLayer[];
    model: ResolvedModel;
    signal?: AbortSignal;
    nowMs?: number;
    modelFactory?: (model: ResolvedModel) => LanguageModel;
}): Promise<string> {
    const nowMs = input.nowMs ?? Date.now();

    const tagged: (TaggedManifestItem & { root: string })[] = [];
    for (const layer of input.layers) {
        const root = resolveMemoryRoot(layer.scope, layer.projectId);
        for (const it of await scanManifest(root)) tagged.push({ ...it, scope: layer.scope, root });
    }
    if (tagged.length === 0) return '';

    const query = input.query.trim();
    let selected: SelectedFile[];
    if (!query || tagged.length <= FAST_PATH_MAX_ITEMS) {
        selected = tagged.map((t) => ({ name: t.name, root: t.root, mtimeMs: t.mtimeMs }));
    } else {
        const ids = await selectRelevantMemories({
            query,
            items: tagged,
            model: input.model,
            signal: input.signal,
            modelFactory: input.modelFactory
        });
        const byId = new Map(tagged.map((t) => [memoryItemId(t), t]));
        selected = ids
            .map((id) => byId.get(id))
            .filter((t): t is TaggedManifestItem & { root: string } => !!t)
            .map((t) => ({ name: t.name, root: t.root, mtimeMs: t.mtimeMs }));
    }
    if (selected.length === 0) return '';

    const blocks: string[] = [];
    let used = 0;
    for (const sel of selected) {
        try {
            const raw = await fs.readFile(path.join(sel.root, `${sel.name}.md`), 'utf8');
            // 只注入正文，剥掉 frontmatter（name/type/updatedAt 等元数据对模型是噪声）
            const body = limitContent(splitFrontmatter(raw).body);
            if (!body) continue;
            if (used + body.length > SESSION_RECALL_BUDGET) break;
            used += body.length;
            blocks.push(`${staleHeader(sel.name, sel.mtimeMs, nowMs)}\n${body}`);
        } catch {
            // 单条读失败不影响其余
        }
    }
    return blocks.join('\n\n');
}
