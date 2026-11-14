import { readIndex } from './index-file';
import type { RecallLayer } from './recall';
import { resolveMemoryRoot } from './scope';

/**
 * 构建记忆注入段：各层索引（始终，便宜）+ 本轮召回正文（可空）。
 * 无任何内容时返回 ''，行为与未接入记忆一致。
 */
export async function buildMemorySection(input: { layers: readonly RecallLayer[]; recalled: string }): Promise<string> {
    const indexParts: string[] = [];
    for (const layer of input.layers) {
        const idx = await readIndex(resolveMemoryRoot(layer.scope, layer.projectId));
        if (idx && idx !== '# Memory') {
            const title = layer.scope === 'global' ? '全局记忆索引' : '项目记忆索引';
            indexParts.push(`### ${title}\n${idx}`);
        }
    }
    const recalled = input.recalled.trim();
    if (indexParts.length === 0 && !recalled) return '';

    const sections = [
        '## 用户记忆',
        [
            '以下是该用户的长期记忆。索引仅供了解有哪些记忆条目；「本轮相关记忆」是据当前问题召回的正文，请在确实适用时主动遵循；识别到新的可长期复用信息时，也主动用 write_memory 更新或新建（「已记住」只在写入成功后才说）。',
            '写入前先确认该条目真实存在：索引里没有的记忆不要用 write_memory 新建来「纠正」；用户否定/纠正某条记忆时用 delete_memory，不确定就先 read_memory 核实。write_memory 返回 created=true 表示本次是新建而非覆盖。',
            '若需要某条索引里有、但正文未附的记忆，用 read_memory 工具按 name 读取（如链接 [preferred-name](preferred-name.md) 的 name 为 preferred-name）；',
            '记忆文件不在工作目录，不要用 Read 或文件路径去读。'
        ].join('')
    ];
    if (indexParts.length > 0) sections.push(indexParts.join('\n\n'));
    if (recalled) sections.push(`### 本轮相关记忆\n${recalled}`);
    return sections.join('\n\n');
}
