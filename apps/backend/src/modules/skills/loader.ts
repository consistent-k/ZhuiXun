import fs from 'node:fs/promises';
import path from 'node:path';

import type { Tool } from 'ai';
import matter from 'gray-matter';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { MCPToolAdapter } from '@/modules/mcp';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('SkillLoader');

export interface LoadedSkill {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    tools: Record<string, Tool>;
    /** 从 tools/index.ts 自动发现的工具信息，用于对外暴露工具元信息 */
    toolInfo: Array<{ name: string; description: string }>;
    preferredModel?: string;
    /** frontmatter allowed-tools：声明式引用的已有工具规则（P2，Claude Code 风格） */
    allowedTools?: string[];
    /** frontmatter disallowed-tools：从 allowed-tools 里排除的规则 */
    disallowedTools?: string[];
}

export interface SkillMetadata {
    id: string;
    name: string;
    description: string;
    dirPath: string;
    loaded: boolean;
    triggers?: string[];
    /** 技能来源：builtin=随包分发只读，user=用户在可写目录自建/上传 */
    source: 'builtin' | 'user';
    /** 是否允许前端编辑/删除（仅 user 技能为 true） */
    editable: boolean;
    /** 是否被用户停用（停用后不进 catalog、不挂载给 agent；builtin/user 都可停用） */
    disabled: boolean;
    /** 来源规范名 `@namespace/slug`（仅 SkillHub 安装的技能有，落在 metadata.source_canonical），
     *  用于技能广场「已安装」按 canonicalName 精确比对（同 slug 跨 namespace 消歧）。 */
    sourceCanonical?: string;
}

/** 用户技能的可编辑源字段（新增/编辑表单与详情回填共用） */
export interface SkillUpsertInput {
    /** 技能 id，kebab-case，同时作为目录名与 frontmatter.name */
    name: string;
    /** 展示名（中文），落到 metadata.display_name */
    displayName?: string;
    description: string;
    triggers?: string[];
    /** SKILL.md 正文，作为 Agent 的 systemPrompt */
    systemPrompt: string;
    /** 声明式工具白名单规则（P2，Claude Code 风格 allowed-tools） */
    allowedTools?: string[];
    /** 声明式工具黑名单规则（disallowed-tools） */
    disallowedTools?: string[];
    /** 透传写入 frontmatter.metadata 的附加键值（如 SkillHub 安装的 source_canonical）。
     *  与 display_name 并列输出；readSkillSource 回读时原样保留，避免编辑/导出丢失 provenance。 */
    extraMetadata?: Record<string, string>;
}

interface SkillFrontmatter {
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    triggers?: string[];
    // Claude Code 风格：单行逗号分隔字符串（如 `allowed-tools: Bash, Read, mcp__x__y`），不是 YAML 数组。
    'allowed-tools'?: string;
    'disallowed-tools'?: string;
}

/**
 * 解析 Claude Code 风格的 allowed-tools / disallowed-tools：单行逗号分隔字符串，
 * 如 `allowed-tools: Bash, Read, mcp__server__tool`。空值或非字符串返回 undefined。
 *
 * 只认 Claude Code 语法，不再兼容早期的 YAML 数组写法（`- Bash`）。
 * 注意：按逗号朴素切分，工具参数模式（如 `Bash(git log:*)`）内部不应含逗号。
 */
function parseToolRules(value: unknown): string[] | undefined {
    if (typeof value !== 'string') return undefined;
    const rules = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return rules.length > 0 ? rules : undefined;
}

interface SkillMarkdown {
    frontmatter: SkillFrontmatter;
    body: string;
}

/**
 * 解析 SKILL.md 的 frontmatter 块（两个 `---` 之间的内容）为对象。
 *
 * 用标准 YAML 解析器（yaml 库）替代原手写的简化解析：手写版只认「顶层 key / 两级缩进 map /
 * 顶层数组」，缩进、引号、冒号稍不合规就静默丢字段、极难排障；合规解析器下，畸形 frontmatter
 * 会抛出带行列信息的错误，由上层记日志（技能被跳过而非静默错配）。
 *
 * - allowed-tools / disallowed-tools 仍是 Claude Code 风格的单行逗号串（如 `Bash, Read`）：
 *   作为普通 YAML 标量字符串原样读入，再由 parseToolRules 按逗号切分——不是 YAML 数组。
 * - metadata 子键统一归一为字符串（类型契约 Record<string,string>），避免 YAML 把 `2.0`
 *   之类值解析成数字后，下游 `.trim()` / 字符串比较出错。
 */
function parseFrontmatterYaml(raw: string): Record<string, unknown> {
    const parsed = parseYaml(raw);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('frontmatter 必须是键值映射');
    }
    const fm = parsed as Record<string, unknown>;

    if (fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata)) {
        const meta: Record<string, string> = {};
        for (const [k, v] of Object.entries(fm.metadata as Record<string, unknown>)) {
            if (v === null || v === undefined) continue;
            meta[k] = typeof v === 'string' ? v : String(v);
        }
        fm.metadata = meta;
    }

    return fm;
}

/**
 * 从 SKILL.md 文本解析 frontmatter + 正文。
 * 抽成纯字符串版，供上传/导入时（内容还没落盘）先校验 frontmatter 用。
 *
 * 用 gray-matter 切分 + 上面的 parseFrontmatterYaml 作解析引擎（engine 抛错原样传播，
 * 保住「frontmatter 必须是键值映射」「Map keys must be unique」等错误契约）。
 */
export function parseSkillMarkdownString(content: string): SkillMarkdown {
    // 兼容 BOM 前缀与 CRLF 换行（Windows 编写 / 上传的 SKILL.md）：先剥 BOM，再把 CRLF 归一为 LF。
    // 否则 frontmatter 正则里硬编码的 \n 匹配不到，解析失败被 catch 成 null，技能在目录中静默消失。
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    // 必须闭合的 frontmatter 门槛：gray-matter 对「有开始定界符但无闭合」的输入宽容（把剩余内容
    // 全当 frontmatter 解析），残缺文件会连带正文被吞成 frontmatter；先按闭合门槛拒绝，守住
    // 「畸形 SKILL.md 跳过并记日志」的原语义（原实现的正则同样要求闭合）。
    if (!/^---\n[\s\S]*?\n---/.test(normalized)) {
        throw new Error('Invalid SKILL.md format (missing frontmatter)');
    }
    const { data, content: body } = matter(normalized, {
        engines: { yaml: { parse: (s: string) => parseFrontmatterYaml(s) } }
    });
    return {
        frontmatter: data as unknown as SkillFrontmatter,
        body: body.trim()
    };
}

async function parseSkillMarkdown(filePath: string): Promise<SkillMarkdown> {
    const content = await fs.readFile(filePath, 'utf-8');
    try {
        return parseSkillMarkdownString(content);
    } catch (err) {
        // 保留底层原因（缺 frontmatter / YAML 语法错误），否则 YAML 报错被统一吞成
        // "missing frontmatter" 会误导排障。
        throw new Error(`SKILL.md 解析失败（${filePath}）：${(err as Error).message}`, { cause: err });
    }
}

/**
 * 自动发现技能目录下 tools/index.ts 导出的工具
 * 返回 { tools: Record<string, any>, toolInfo: Array<{ name, description }> }
 *
 * 按导出形状区分两种情况，互斥处理，避免同一个 value 被两个分支重复处理：
 * - 具名导出的工具对象（如 `export const xxxTools = { toolA, toolB }`）：
 *   遍历其 entries，每个 entry 是一个 tool。
 * - 具名导出单个 tool（如 `export const myTool = tool({...})`）：
 *   用导出的变量名（而不是技能目录名）作为工具名。
 */
async function discoverTools(skillDir: string): Promise<{
    tools: Record<string, Tool>;
    toolInfo: Array<{ name: string; description: string }>;
}> {
    const toolsPath = path.join(skillDir, 'tools', 'index.js');
    const tools: Record<string, Tool> = {};
    const toolInfo: Array<{ name: string; description: string }> = [];

    const isTool = (v: unknown): v is { description?: string; execute: unknown } =>
        typeof v === 'object' && v !== null && 'execute' in v;

    try {
        const mod = await import(toolsPath);

        for (const [exportName, value] of Object.entries(mod)) {
            if (typeof value !== 'object' || value === null) continue;

            if (isTool(value)) {
                // 具名导出单个 tool：用导出变量名作为工具名
                // isTool 已保证 execute 形状，动态 import 的值按 AI SDK Tool 断言（原 any 的语义保留）
                tools[exportName] = value as unknown as Tool;
                toolInfo.push({ name: exportName, description: value.description || '' });
                continue;
            }

            // 具名导出的工具集合对象：遍历内部 entries
            for (const [toolName, toolValue] of Object.entries(value as Record<string, unknown>)) {
                if (isTool(toolValue)) {
                    tools[toolName] = toolValue as unknown as Tool;
                    toolInfo.push({ name: toolName, description: toolValue.description || '' });
                }
            }
        }
    } catch {
        // tools/index.ts 不存在或加载失败，返回空
    }

    return { tools, toolInfo };
}

export async function loadSkillFromDirectory(skillDir: string, _mcpAdapter: MCPToolAdapter): Promise<LoadedSkill> {
    const { frontmatter, body: systemPrompt } = await parseSkillMarkdown(path.join(skillDir, 'SKILL.md'));

    const { tools, toolInfo } = await discoverTools(skillDir);

    const allowedTools = parseToolRules(frontmatter['allowed-tools']);
    const disallowedTools = parseToolRules(frontmatter['disallowed-tools']);

    return {
        id: frontmatter.name,
        name: frontmatter.metadata?.display_name || frontmatter.name,
        description: frontmatter.description,
        systemPrompt,
        tools,
        toolInfo,
        preferredModel: frontmatter.metadata?.preferred_model,
        allowedTools,
        disallowedTools
    };
}

export async function parseSkillFrontmatter(skillDir: string): Promise<SkillFrontmatter | null> {
    try {
        const { frontmatter } = await parseSkillMarkdown(path.join(skillDir, 'SKILL.md'));
        return frontmatter;
    } catch (error) {
        // 技能格式写错时该技能会从系统中消失，必须留日志才能排障
        log.error('解析 SKILL.md 失败，技能将被跳过', { skillDir, err: error });
        return null;
    }
}

/**
 * 读取技能源字段，用于前端编辑回填。
 *
 * 与 loadSkillFromDirectory 的区别：后者产出运行时 LoadedSkill（含工具、展示名归一），
 * 这里返回的是「用户填写过什么」的原样字段（frontmatter.name / display_name / triggers /
 * 正文原文），供 SkillForm 回填，与 serializeSkillMarkdown 互为读写对。
 */
export async function readSkillSource(skillDir: string): Promise<SkillUpsertInput> {
    const { frontmatter, body } = await parseSkillMarkdown(path.join(skillDir, 'SKILL.md'));
    // 保留 display_name 以外的 metadata 键（如 source_canonical），编辑回写时不丢 provenance。
    const extraMetadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(frontmatter.metadata || {})) {
        if (k === 'display_name') continue;
        if (typeof v === 'string' && v.trim()) extraMetadata[k] = v.trim();
    }
    return {
        name: frontmatter.name,
        displayName: frontmatter.metadata?.display_name,
        description: frontmatter.description || '',
        triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers : undefined,
        allowedTools: parseToolRules(frontmatter['allowed-tools']),
        disallowedTools: parseToolRules(frontmatter['disallowed-tools']),
        extraMetadata: Object.keys(extraMetadata).length ? extraMetadata : undefined,
        systemPrompt: body
    };
}

/**
 * 把用户填写的字段序列化为 SKILL.md 文本（frontmatter 用 yaml 库输出，正文接在第二个 --- 之后）。
 *
 * 用 yaml.stringify 而非手拼行：含冒号/特殊字符的值（如 description）会被自动加引号，保证
 * 「写出去的能被 YAML 解析器原样读回」，不再依赖手写解析器的缩进巧合。字段顺序由对象插入
 * 顺序决定（yaml 保留 key 顺序）。lineWidth:0 关闭自动折行，避免长 description 被折成多行。
 *
 * allowed-tools / disallowed-tools 仍输出为 Claude Code 风格的单行逗号串（普通标量，不是 YAML
 * 数组），与 parseToolRules 的按逗号切分保持一致。
 */
export function serializeSkillMarkdown(input: SkillUpsertInput): string {
    const oneLine = (v: string) => v.replace(/\r?\n/g, ' ').trim();

    const fm: Record<string, unknown> = {
        name: oneLine(input.name),
        description: oneLine(input.description),
        license: 'Internal',
        compatibility: 'zhuixun 2.x'
    };

    // metadata 子 map：仅输出有值的键。display_name 在前，其余 extraMetadata（如 source_canonical）在后。
    const metadata: Record<string, string> = {};
    if (input.displayName) metadata.display_name = oneLine(input.displayName);
    for (const [k, v] of Object.entries(input.extraMetadata || {})) {
        if (k === 'display_name') continue; // 已由 displayName 处理，避免重复
        const val = oneLine(String(v ?? ''));
        if (val) metadata[k] = val;
    }
    if (Object.keys(metadata).length > 0) fm.metadata = metadata;

    const triggers = (input.triggers || []).map((t) => oneLine(t)).filter(Boolean);
    if (triggers.length > 0) fm.triggers = triggers;

    const allowed = (input.allowedTools || []).map((t) => oneLine(t)).filter(Boolean);
    if (allowed.length > 0) fm['allowed-tools'] = allowed.join(', ');
    const disallowed = (input.disallowedTools || []).map((t) => oneLine(t)).filter(Boolean);
    if (disallowed.length > 0) fm['disallowed-tools'] = disallowed.join(', ');

    const frontmatter = stringifyYaml(fm, { lineWidth: 0 }).trimEnd();
    return `---\n${frontmatter}\n---\n\n${input.systemPrompt.trim()}\n`;
}

export function formatSkillCatalog(metadata: SkillMetadata[]): string {
    if (metadata.length === 0) {
        return '## 可用技能\n暂无可用技能';
    }

    const lines = metadata.map((s) => {
        let line = `- ${s.id}: ${s.description}`;
        if (s.triggers && s.triggers.length > 0) {
            line += `（触发词：${s.triggers.join('、')}）`;
        }
        return line;
    });

    return `## 可用技能\n${lines.join('\n')}`;
}
