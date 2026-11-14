import fsp from 'node:fs/promises';
import path from 'node:path';

import type { CommandDetail, CommandSummary, CommandUpsertInput } from '@zhuixun/shared';
import matter from 'gray-matter';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { paths } from '@/config/paths';
import { createLogger } from '@/platform/logging/index';

import { BUILTIN_COMMAND_NAMES, COMMAND_NAME_RE } from './expand';

const log = createLogger('Commands');

/** 模板正文上限，防把巨型文本当命令每轮喂给模型。 */
export const MAX_COMMAND_BODY_CHARS = 20_000;
const MAX_META_CHARS = 200;

export class CommandError extends Error {
    constructor(
        readonly status: 400 | 404,
        message: string
    ) {
        super(message);
        this.name = 'CommandError';
    }
}

/** 校验命令名：非法 / 与内置命令重名一律拒绝。 */
export function assertCommandName(name: string): void {
    if (!COMMAND_NAME_RE.test(name)) {
        throw new CommandError(400, '命令名只能包含小写字母、数字与连字符（1–32 位，且以字母或数字开头）');
    }
    if (BUILTIN_COMMAND_NAMES.has(name)) throw new CommandError(400, `「/${name}」是内置命令，不能覆盖`);
}

function oneLine(value: string | undefined): string | undefined {
    const v = value?.replace(/\r?\n/g, ' ').trim();
    return v ? v.slice(0, MAX_META_CHARS) : undefined;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 拆 frontmatter：与技能 / 记忆同一套 yaml 引擎，畸形 YAML 抛错；去掉前导 BOM。 */
function splitFrontmatter(md: string): { data: Record<string, unknown>; body: string } {
    const source = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
    const { data, content } = matter(source, { engines: { yaml: { parse: (s: string) => parseYaml(s) } } });
    const safe = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    return { data: safe, body: content.trim() };
}

/** 解析命令文件；frontmatter 畸形时抛错（列表层跳过该命令）。 */
export function parseCommandMarkdown(name: string, md: string): CommandDetail {
    const { data, body } = splitFrontmatter(md);
    const description = readString(data.description);
    const argumentHint = readString(data['argument-hint']);
    return {
        name,
        ...(description ? { description } : {}),
        ...(argumentHint ? { argumentHint } : {}),
        body
    };
}

/** 序列化：yaml 库负责给含冒号 / 引号的值加引号，保证往返。 */
export function serializeCommandMarkdown(input: CommandUpsertInput): string {
    const fm: Record<string, string> = {};
    const description = oneLine(input.description);
    const argumentHint = oneLine(input.argumentHint);
    if (description) fm.description = description;
    if (argumentHint) fm['argument-hint'] = argumentHint;
    const body = input.body.trim();
    if (Object.keys(fm).length === 0) return `${body}\n`;
    return `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}\n`;
}

/**
 * 命令存储：`~/.zhuixun/commands/<name>.md`（COMMANDS_USER_DIR 可覆盖）。
 * 每次读都直接读盘（文件小、数量少），手工编辑无需重启即生效；写入走临时文件 + rename。
 */
export class CommandStore {
    constructor(private readonly dir: string = paths.commandsDir()) {}

    private file(name: string): string {
        return path.join(this.dir, `${name}.md`);
    }

    async list(): Promise<CommandSummary[]> {
        let entries: string[];
        try {
            entries = await fsp.readdir(this.dir);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('读取命令目录失败', { err: error });
            return [];
        }
        const out: CommandSummary[] = [];
        for (const entry of entries.sort()) {
            const name = entry.replace(/\.md$/, '');
            if (!entry.endsWith('.md') || !COMMAND_NAME_RE.test(name) || BUILTIN_COMMAND_NAMES.has(name)) continue;
            const detail = await this.get(name);
            if (detail) out.push({ name, description: detail.description, argumentHint: detail.argumentHint });
        }
        return out;
    }

    /** 读取单个命令；不存在、名称非法或文件畸形返回 null。 */
    async get(name: string): Promise<CommandDetail | null> {
        if (!COMMAND_NAME_RE.test(name) || BUILTIN_COMMAND_NAMES.has(name)) return null;
        let md: string;
        try {
            md = await fsp.readFile(this.file(name), 'utf8');
        } catch {
            return null;
        }
        try {
            return parseCommandMarkdown(name, md);
        } catch (error) {
            log.warn('命令文件格式不合法，已跳过', { name, err: error });
            return null;
        }
    }

    async save(name: string, input: CommandUpsertInput): Promise<CommandDetail> {
        assertCommandName(name);
        if (!input.body.trim()) throw new CommandError(400, '模板正文不能为空');
        if (input.body.length > MAX_COMMAND_BODY_CHARS) {
            throw new CommandError(400, `模板正文过长（上限 ${MAX_COMMAND_BODY_CHARS} 字符）`);
        }
        await fsp.mkdir(this.dir, { recursive: true });
        const target = this.file(name);
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fsp.writeFile(tmp, serializeCommandMarkdown(input), 'utf8');
            await fsp.rename(tmp, target);
        } catch (error) {
            await fsp.rm(tmp, { force: true });
            throw error;
        }
        return (await this.get(name))!;
    }

    /** 删除命令；不存在视为成功（幂等）。 */
    async delete(name: string): Promise<void> {
        if (!COMMAND_NAME_RE.test(name)) throw new CommandError(400, '非法命令名');
        await fsp.rm(this.file(name), { force: true });
    }

    /** 展开用：只取模板正文。 */
    async bodyOf(name: string): Promise<string | undefined> {
        return (await this.get(name))?.body;
    }
}

let store: CommandStore | null = null;

export function getCommandStore(): CommandStore {
    if (!store) store = new CommandStore();
    return store;
}
