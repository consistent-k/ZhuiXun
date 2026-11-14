import matter from 'gray-matter';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { isMemoryType, type MemoryRecord, type MemoryType } from './types';

export interface SplitResult {
    data: Record<string, unknown>;
    body: string;
}

/** 去掉可能的前导 BOM（U+FEFF）。gray-matter 用 startsWith 判开启定界符，带 BOM 会判「无 frontmatter」。 */
function stripBom(md: string): string {
    return md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
}

/**
 * 拆分 frontmatter 与正文；无 frontmatter 时 data 为空、整篇为正文。畸形 YAML 抛错（由上层跳过该条）。
 * 用 gray-matter 切分 + 现有 yaml 库做解析引擎（engine 抛错原样传播，保住「Map keys must be unique」等契约）。
 */
export function splitFrontmatter(md: string): SplitResult {
    const { data, content } = matter(stripBom(md), {
        engines: { yaml: { parse: (s: string) => parseYaml(s) } }
    });
    const safe = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    return { data: safe, body: content.trim() };
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readMetadata(data: Record<string, unknown>): Record<string, unknown> {
    return data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
        ? (data.metadata as Record<string, unknown>)
        : {};
}

function resolveType(data: Record<string, unknown>, meta: Record<string, unknown>): MemoryType | undefined {
    if (isMemoryType(meta.type)) return meta.type;
    if (isMemoryType(data.type)) return data.type;
    return undefined;
}

/** 解析一条记忆文件为结构化记录；name 以文件名为准（frontmatter 不可信时兜底）。 */
export function parseMemoryRecord(md: string, fallbackName: string): MemoryRecord {
    const { data, body } = splitFrontmatter(md);
    const meta = readMetadata(data);
    return {
        name: readString(data.name) ?? fallbackName,
        type: resolveType(data, meta) ?? 'user',
        description: readString(data.description) ?? '',
        content: body,
        updatedAt: readString(meta.updatedAt) ?? new Date(0).toISOString(),
        originSessionId: readString(meta.originSessionId)
    };
}

/** 只读 frontmatter 轻量字段（清单用），不依赖正文。 */
export function readManifestFields(md: string): {
    type?: MemoryType;
    description?: string;
    updatedAt?: string;
} {
    const { data } = splitFrontmatter(md);
    const meta = readMetadata(data);
    return {
        type: resolveType(data, meta),
        description: readString(data.description),
        updatedAt: readString(meta.updatedAt)
    };
}

/** 序列化为带 frontmatter 的 Markdown（含冒号/逗号的值由 yaml 库自动加引号保证往返）。 */
export function serializeMemoryRecord(record: MemoryRecord): string {
    const frontmatter = stringifyYaml({
        name: record.name,
        description: record.description,
        metadata: {
            type: record.type,
            updatedAt: record.updatedAt,
            ...(record.originSessionId ? { originSessionId: record.originSessionId } : {})
        }
    }).trimEnd();
    return `---\n${frontmatter}\n---\n${record.content.trim()}\n`;
}
