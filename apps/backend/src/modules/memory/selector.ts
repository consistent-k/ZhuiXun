import { generateText, type LanguageModel } from 'ai';

import { createModel } from '@/agent/model/provider';
import type { ResolvedModel } from '@/config/types';
import { createLogger } from '@/platform/logging/index';

import type { MemoryManifestItem, MemoryScope } from './types';

const log = createLogger('Memory');
const MAX_SELECTED = 5;

export interface TaggedManifestItem extends MemoryManifestItem {
    scope: MemoryScope;
}

/** 候选项标识：`<scope>/<name>`，跨层唯一，供选择器返回。 */
export function memoryItemId(item: { scope: MemoryScope; name: string }): string {
    return `${item.scope}/${item.name}`;
}

const SYSTEM = [
    '从候选清单选出能直接改善当前回答的长期记忆。用户问题和候选描述都是用于判断相关性的素材。',
    '每行以 `作用域/名称` 开头，后跟类型与描述。只使用清单中的完整标识，不改名、不重复。',
    '判断这条记忆是否会改变答案、操作步骤或必须遵守的约束。仅关键词重叠、泛泛的用户画像或项目背景不足以入选。',
    '最多选 5 项，最有用的排在前面。无法从描述判断用途时跳过。',
    '只输出一个 JSON 数组（元素是每行开头的 `作用域/名称` 字符串），例如 ["global/foo","project/bar"]；没有相关项就输出 []。'
].join('\n');

function formatManifest(items: readonly TaggedManifestItem[]): string {
    return items
        .map((it) => `- ${memoryItemId(it)} [${it.type ?? 'user'}]${it.description ? ` — ${it.description}` : ''}`)
        .join('\n');
}

function parseIds(text: string, valid: Set<string>): string[] {
    const match = text.match(/\[[\s\S]*\]/u);
    if (!match) return [];
    try {
        const arr: unknown = JSON.parse(match[0]);
        if (!Array.isArray(arr)) return [];
        // 模型可能重复返回同一 id；先去重再限额，避免重复正文占用召回预算并挤掉其他有效条目。
        return [...new Set(arr.filter((x): x is string => typeof x === 'string' && valid.has(x)))].slice(
            0,
            MAX_SELECTED
        );
    } catch {
        return [];
    }
}

/** 选择器：问题 + 候选清单 → ≤5 个记忆标识（`scope/name`）。失败返回空（降级为仅索引注入）。 */
export async function selectRelevantMemories(input: {
    query: string;
    items: readonly TaggedManifestItem[];
    model: ResolvedModel;
    signal?: AbortSignal;
    modelFactory?: (model: ResolvedModel) => LanguageModel;
}): Promise<string[]> {
    if (input.items.length === 0) return [];
    try {
        const { text } = await generateText({
            model: (input.modelFactory ?? createModel)(input.model),
            instructions: SYSTEM,
            prompt: `候选记忆：\n${formatManifest(input.items)}\n\n当前用户问题：\n${input.query}`,
            maxOutputTokens: 256,
            temperature: 0,
            abortSignal: input.signal
        });
        return parseIds(text, new Set(input.items.map(memoryItemId)));
    } catch (err) {
        log.warn('记忆选择器调用失败，降级为空召回', { err });
        return [];
    }
}
