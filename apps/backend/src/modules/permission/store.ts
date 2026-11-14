import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { BashRule, PermissionData, PermissionRuleSet, RememberResult, WriteRule } from '@zhuixun/shared';

import { writeJsonAtomic } from '@/config/atomic-json';
import { paths } from '@/config/paths';
import { deriveCommandHead } from '@/platform/command';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('Permission');

export type { BashRule, PermissionData, RememberResult, WriteRule };

/** 记忆一条命令/写入目录的入参。 */
export interface RememberInput {
    /** 工具类型：Bash（命令头）或 Write（目录前缀）。缺省视为 Bash。 */
    tool?: 'Bash' | 'Write';
    /** Bash：原始命令字符串 */
    command?: string;
    /** Write：目标文件绝对路径（由此推导放行目录） */
    filePath?: string;
    /** 生效范围：永久落盘 / 仅本次会话（内存） */
    scope: 'permanent' | 'session';
    /** 会话 id，scope 为 session 时使用；为空则降级为「仅本次放行」不落规则 */
    sessionId?: string;
}

/** v3 起新增声明式 `rules`；v2 文件读入时补空，首次写回即升版（不改动既有 bash/write 记忆）。 */
const DATA_VERSION = 3;

const emptyRules = (): PermissionRuleSet => ({ deny: [], ask: [], allow: [] });

const DEFAULT_DATA: PermissionData = {
    version: DATA_VERSION,
    autoApprovalEnabled: true,
    bash: { allow: [] },
    write: { allow: [] },
    rules: emptyRules()
};

/** 读入落盘的 rules 段：只保留字符串项；语法校验由 policy 编译时做（非法项跳过并告警）。 */
function readRules(raw: unknown): PermissionRuleSet {
    const out = emptyRules();
    if (!raw || typeof raw !== 'object') return out;
    for (const kind of ['deny', 'ask', 'allow'] as const) {
        const list = (raw as Record<string, unknown>)[kind];
        if (Array.isArray(list)) out[kind] = list.filter((r): r is string => typeof r === 'string');
    }
    return out;
}

function cloneRules(rules: PermissionRuleSet): PermissionRuleSet {
    return { deny: [...rules.deny], ask: [...rules.ask], allow: [...rules.allow] };
}

function cloneData(data: PermissionData): PermissionData {
    return {
        ...data,
        bash: { allow: [...data.bash.allow] },
        write: { allow: [...data.write.allow] },
        rules: cloneRules(data.rules)
    };
}

/**
 * Write 永不记忆的目录前缀（系统/配置目录）：即便用户点「记住」，落在这些目录仍每次询问，
 * 避免模型借记忆静默写系统文件 / 覆盖应用自身配置。fail-safe：解析不出绝对目录也拒绝记忆。
 */
function writeDenyRoots(): string[] {
    const home = os.homedir();
    const common = [
        home, // 家目录根本身（子目录仍可记忆）
        path.join(home, '.zhuixun'), // 应用自身配置/数据
        path.join(home, '.ssh')
    ];
    if (process.platform === 'win32') {
        const env = process.env;
        const drive = path.parse(env.SystemRoot || 'C:\\Windows').root; // 系统盘根，如 C:\
        return [
            drive,
            env.SystemRoot || path.join(drive, 'Windows'),
            env.ProgramFiles || path.join(drive, 'Program Files'),
            env['ProgramFiles(x86)'] || path.join(drive, 'Program Files (x86)'),
            env.ProgramData || path.join(drive, 'ProgramData'),
            ...(env.APPDATA ? [env.APPDATA] : []),
            ...(env.LOCALAPPDATA ? [env.LOCALAPPDATA] : []),
            ...common
        ];
    }
    return [
        '/',
        '/etc',
        '/usr',
        '/bin',
        '/sbin',
        '/boot',
        '/dev',
        '/proc',
        '/sys',
        '/var',
        '/private',
        '/System',
        '/Library',
        ...common
    ];
}

/** Windows 路径大小写不敏感：比较前统一转小写。 */
function samePath(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Write 目录解析：取 filePath 所在目录，规范化为绝对路径；相对路径 / 命中 denylist 视为不可记忆。 */
function deriveWriteDir(filePath: string): { safe: boolean; dir?: string; reason?: 'relative' | 'denylisted' } {
    const trimmed = (filePath || '').trim();
    if (!trimmed || !path.isAbsolute(trimmed)) return { safe: false, reason: 'relative' };
    const dir = path.resolve(path.dirname(trimmed));
    const deny = writeDenyRoots().map((d) => path.resolve(d));
    if (deny.some((d) => samePath(d, dir))) return { safe: false, dir, reason: 'denylisted' };
    return { safe: true, dir };
}

/**
 * 写入目标是否落在系统目录 denylist（或无法解析为绝对路径）：策略 allow / hook allow 只是「免确认」，
 * 不越过这层保护，命中时仍需用户确认。
 */
export function isWriteDenylisted(filePath: string): boolean {
    return !deriveWriteDir(filePath).safe;
}

/** 判断写入目标是否落在某个已放行目录（相等或其子目录）内。 */
function fileWithinDir(filePath: string, dir: string): boolean {
    const target = path.resolve(filePath);
    const base = path.resolve(dir);
    if (samePath(target, base)) return true;
    // path.win32.relative 本身大小写不敏感，posix 下大小写敏感，与各自文件系统语义一致
    const rel = path.relative(base, target);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 权限规则文件：落在用户可写目录 `~/.zhuixun/permissions.json`，与 memory / skills 同源。
 * 可用 env `PERMISSION_USER_DIR` 覆盖（与 `MEMORY_USER_DIR` / `SKILLS_USER_DIR` 对应）。
 */
function resolvePermissionFile(): string {
    return paths.permissionFile();
}

/**
 * 权限存储：永久规则落盘 JSON（串行队列 + 临时文件 rename 原子写，仿 memory/store.ts），
 * 会话规则存进程内存 Map（重启即失效，天然满足「仅本次会话」）。
 *
 * 放行判定 `resolveBashApproval` 是审批网关的唯一真源：任何异常 / 文件损坏一律退化为
 * 「仍然询问」，绝不 fail-open 自动放行。
 */
export class PermissionStore {
    private readonly filePath: string;
    private cache: PermissionData | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(filePath = resolvePermissionFile()) {
        this.filePath = filePath;
    }
    /** 会话内存规则：sessionId -> 已放行命令头集合 */
    private sessionAllow = new Map<string, Set<string>>();
    /** 会话内存 Write 规则：sessionId -> 已放行目录集合 */
    private sessionWriteAllow = new Map<string, Set<string>>();

    private loadFailure?: unknown;

    private async load(throwOnError = false): Promise<PermissionData> {
        if (this.cache) {
            if (throwOnError && this.loadFailure) throw this.loadFailure;
            return this.cache;
        }
        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<PermissionData>;
            this.cache = {
                version: typeof parsed.version === 'number' ? parsed.version : DEFAULT_DATA.version,
                // 缺省视为开启（与 DEFAULT 一致）；仅显式 false 才关闭
                autoApprovalEnabled: parsed.autoApprovalEnabled !== false,
                bash: {
                    allow: Array.isArray(parsed.bash?.allow)
                        ? parsed.bash!.allow.filter(
                              (r): r is BashRule => !!r && typeof r.id === 'string' && typeof r.head === 'string'
                          )
                        : []
                },
                write: {
                    allow: Array.isArray(parsed.write?.allow)
                        ? parsed.write!.allow.filter(
                              (r): r is WriteRule => !!r && typeof r.id === 'string' && typeof r.dir === 'string'
                          )
                        : []
                },
                rules: readRules(parsed.rules)
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                // 文件损坏：告警并按空规则处理（fail-safe，绝不因此自动放行）
                this.loadFailure = err;
                log.error('读取权限文件失败，按空规则处理', { err });
                if (throwOnError) throw err;
            }
            this.cache = cloneData(DEFAULT_DATA);
        }
        return this.cache;
    }

    private enqueue<T>(fn: (data: PermissionData) => T): Promise<T> {
        const run = this.queue.then(async () => {
            const current = await this.load();
            const draft: PermissionData = { ...cloneData(current), version: DATA_VERSION };
            const result = fn(draft);
            await this.persist(draft);
            return result;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async persist(data: PermissionData): Promise<void> {
        // 原子写与失败清理委托给 platform/fs；写入成功后才提交内存缓存。
        await writeJsonAtomic(this.filePath, data);
        this.cache = data;
        this.loadFailure = undefined;
    }

    /** 读取永久权限快照（总开关 + 规则列表）。 */
    async get(): Promise<PermissionData> {
        return cloneData(await this.load());
    }

    /** 读取用户声明式规则（未经语法校验的原文）。 */
    async getRules(): Promise<PermissionRuleSet> {
        return cloneRules((await this.load()).rules);
    }

    /** 整段覆盖写用户声明式规则（调用方负责校验规整）。 */
    async setRules(rules: PermissionRuleSet): Promise<PermissionRuleSet> {
        return this.enqueue((data) => {
            data.rules = cloneRules(rules);
            return cloneRules(data.rules);
        });
    }

    /**
     * 审批网关判定：命中已记忆的命令头、或处于信任项目时返回 `approved`（自动放行），否则 `user-approval`。
     * 复合命令 / 无法解析 / 危险命令头 / 任何异常都返回 `user-approval`（信任态同样不放行危险头）。
     *
     * @param command 模型给出的原始 Bash 命令
     * @param sessionId 当前会话 id（用于会话内存规则）
     * @param trust 信任上下文：项目被用户显式信任且其根集合非空时，安全命令头在该项目对话中自动放行
     */
    async resolveBashApproval(
        command: string,
        sessionId?: string,
        trust?: { roots: string[] },
        throwOnError = false
    ): Promise<'approved' | 'user-approval'> {
        try {
            const data = await this.load(throwOnError);
            const { safe, head } = deriveCommandHead(command);
            // 复合/危险命令头：无论记忆规则还是信任项目都不放行
            if (!safe || !head) return 'user-approval';
            // 信任项目：安全命令头在该项目对话中自动放行（独立于全局自动放行总开关的显式授权）
            if (trust && trust.roots.length > 0) return 'approved';
            if (!data.autoApprovalEnabled) return 'user-approval';

            const sessionHit = sessionId ? this.sessionAllow.get(sessionId)?.has(head) : false;
            const permanentHit = data.bash.allow.some((r) => r.head === head);
            return sessionHit || permanentHit ? 'approved' : 'user-approval';
        } catch (err) {
            if (throwOnError) throw err;
            log.error('审批判定异常，退化为需用户确认', { err });
            return 'user-approval';
        }
    }

    /**
     * Write 审批网关判定：写入目标落在已记忆目录（或其子目录）、或落在信任项目的任一根内返回 `approved`，否则 `user-approval`。
     * 相对路径 / 系统目录（denyRoots）/ 任何异常都返回 `user-approval`（信任态同样受 denyRoots 约束，fail-safe）。
     */
    async resolveWriteApproval(
        filePath: string,
        sessionId?: string,
        trust?: { roots: string[] },
        throwOnError = false
    ): Promise<'approved' | 'user-approval'> {
        try {
            const data = await this.load(throwOnError);
            const { safe, dir } = deriveWriteDir(filePath);
            // 相对路径 / 命中系统目录：信任态也不放行
            if (!safe || !dir) return 'user-approval';
            // 信任项目：目标落在任一根范围内即自动放行
            if (trust && trust.roots.some((root) => fileWithinDir(filePath, root))) return 'approved';
            if (!data.autoApprovalEnabled) return 'user-approval';

            const sessionDirs = sessionId ? this.sessionWriteAllow.get(sessionId) : undefined;
            const sessionHit = sessionDirs ? [...sessionDirs].some((d) => fileWithinDir(filePath, d)) : false;
            const permanentHit = data.write.allow.some((r) => fileWithinDir(filePath, r.dir));
            return sessionHit || permanentHit ? 'approved' : 'user-approval';
        } catch (err) {
            if (throwOnError) throw err;
            log.error('Write 审批判定异常，退化为需用户确认', { err });
            return 'user-approval';
        }
    }

    /**
     * 记忆一条命令（Bash）或写入目录（Write）：永久落盘或加入会话内存。
     * Bash：复合 / 无法解析 / 危险命令头拒绝记忆。Write：相对路径 / 系统目录拒绝记忆。
     * 会话范围但无 sessionId 时降级为不落规则。
     */
    async remember(input: RememberInput): Promise<RememberResult> {
        if (input.tool === 'Write') return this.rememberWrite(input);
        return this.rememberBash(input);
    }

    private async rememberBash(input: RememberInput): Promise<RememberResult> {
        const { safe, head, reason } = deriveCommandHead(input.command ?? '');
        if (!safe || !head) return { rule: null, skipped: reason ?? 'unsafe' };

        if (input.scope === 'session') {
            if (!input.sessionId) return { rule: null, skipped: 'no-session' };
            const set = this.sessionAllow.get(input.sessionId) ?? new Set<string>();
            set.add(head);
            this.sessionAllow.set(input.sessionId, set);
            return { rule: { id: crypto.randomUUID(), head, createdAt: Date.now() } };
        }

        return this.enqueue((data) => {
            const existing = data.bash.allow.find((r) => r.head === head);
            if (existing) return { rule: existing };
            const rule: BashRule = { id: crypto.randomUUID(), head, createdAt: Date.now() };
            data.bash.allow.push(rule);
            return { rule };
        });
    }

    private async rememberWrite(input: RememberInput): Promise<RememberResult> {
        const { safe, dir, reason } = deriveWriteDir(input.filePath ?? '');
        if (!safe || !dir) return { rule: null, skipped: reason ?? 'relative' };

        if (input.scope === 'session') {
            if (!input.sessionId) return { rule: null, skipped: 'no-session' };
            const set = this.sessionWriteAllow.get(input.sessionId) ?? new Set<string>();
            set.add(dir);
            this.sessionWriteAllow.set(input.sessionId, set);
            return { rule: { id: crypto.randomUUID(), dir, createdAt: Date.now() } };
        }

        return this.enqueue((data) => {
            const existing = data.write.allow.find((r) => r.dir === dir);
            if (existing) return { rule: existing };
            const rule: WriteRule = { id: crypto.randomUUID(), dir, createdAt: Date.now() };
            data.write.allow.push(rule);
            return { rule };
        });
    }

    /** 删除一条永久规则（Bash 或 Write）；id 不存在视为成功（幂等）。 */
    async deleteRule(id: string): Promise<void> {
        await this.enqueue((data) => {
            data.bash.allow = data.bash.allow.filter((r) => r.id !== id);
            data.write.allow = data.write.allow.filter((r) => r.id !== id);
        });
    }

    /** 切换自动放行总开关。 */
    async setAutoApproval(enabled: boolean): Promise<PermissionData> {
        return this.enqueue((data) => {
            data.autoApprovalEnabled = enabled;
            return cloneData(data);
        });
    }
}

let store: PermissionStore | null = null;

/** 获取权限存储单例。 */
export function createPermissionStore(filePath: string = resolvePermissionFile()): PermissionStore {
    return new PermissionStore(filePath);
}

export function getPermissionStore(): PermissionStore {
    if (!store) store = createPermissionStore();
    return store;
}
