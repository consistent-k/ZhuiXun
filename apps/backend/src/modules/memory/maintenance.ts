import fs from 'node:fs/promises';
import path from 'node:path';

import { generateText } from 'ai';

import { createModel } from '@/agent/model/provider';
import { activeModel } from '@/config/model';
import { getMemorySettings } from '@/config/settings-store';
import type { ResolvedModel } from '@/config/types';
import { createLogger } from '@/platform/logging/index';

import { scanManifest } from './manifest';
import { applyMemoryOps, parseMemoryOps } from './ops';
import { globalMemoryRoot, resolveMemoryRoot } from './scope';
import { getMemoryStore } from './store';
import type { MemoryManifestItem } from './types';

const log = createLogger('Memory');

/** 对话转写（供抽取分析）：只取纯文本的 user/assistant 消息。 */
export interface TranscriptMessage {
    role: 'user' | 'assistant';
    content: string;
}

const MIN_USER_WORDS = 3;
const TRANSCRIPT_CHAR_CAP = 12_000;

const DREAM_LOCK_FILE = '.consolidate-lock';
const DREAM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DREAM_SCAN_THROTTLE_MS = 10 * 60 * 1000;
const DREAM_MIN_RECORDS = 3;

/** 近似「有实质用户输入」：任一 user 文本词数 ≥ 阈值。 */
function hasSubstantialUserProse(transcript: readonly TranscriptMessage[]): boolean {
    return transcript.some(
        (m) => m.role === 'user' && m.content.trim().split(/\s+/u).filter(Boolean).length >= MIN_USER_WORDS
    );
}

function formatManifest(items: readonly MemoryManifestItem[], scope: string): string {
    if (items.length === 0) return `（${scope} 层暂无记忆）`;
    return items.map((it) => `- [${scope}/${it.type ?? 'user'}] ${it.name}: ${it.description ?? ''}`).join('\n');
}

const EXTRACTION_SYSTEM = [
    '你是记忆抽取子程序。阅读下面最近的对话，判断是否有「值得长期记住」的用户个人信息。',
    '只抽取可长期复用的内容：user=用户是谁(身份/角色/专长/称呼)；feedback=对你工作方式的纠正或确认；',
    'project=在做的事/关注领域等；reference=常用文档链接/内部系统等。',
    '\n不要记录：仅本轮的临时任务上下文、第三方可识别隐私、敏感凭据、从对话无法确证的猜测。',
    '\n已存在的记忆清单见下；若新信息与某条属于同一事项，用相同 name 覆盖更新，不要制造重复或矛盾条目。',
    '\n输出一个 JSON 数组，每个元素形如',
    ' {"action":"write","scope":"global|project","name":"kebab-slug","type":"user|feedback|project|reference","description":"一行摘要","content":"正文"}',
    ' 或 {"action":"delete","scope":"...","name":"..."}。没有要保存的就输出 []，不要任何额外解释。'
].join('');

/** 仅注入配置读取与模型边界；在途状态归实例所有，默认实例仍供生产入口共用。 */
export function createMemoryMaintenance(
    deps: {
        getSettings?: typeof getMemorySettings;
        getModel?: typeof activeModel;
        modelFactory?: typeof createModel;
    } = {}
) {
    const settingsReader = deps.getSettings ?? getMemorySettings;
    const modelReader = deps.getModel ?? activeModel;
    const modelFactory = deps.modelFactory ?? createModel;

    /** P1：每轮结束后从对话抽取记忆并写入。best-effort，不抛错。 */
    async function runExtraction(input: {
        transcript: readonly TranscriptMessage[];
        projectId?: string;
        sessionId?: string;
        model: ResolvedModel;
        signal?: AbortSignal;
    }): Promise<void> {
        if (!hasSubstantialUserProse(input.transcript)) return;

        const hasProject = !!input.projectId;
        const [globalItems, projectItems] = await Promise.all([
            scanManifest(globalMemoryRoot()),
            hasProject ? scanManifest(resolveMemoryRoot('project', input.projectId)) : Promise.resolve([])
        ]);
        const manifest = `${formatManifest(globalItems, 'global')}\n${hasProject ? formatManifest(projectItems, 'project') : ''}`;

        const convo = input.transcript
            .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
            .join('\n\n')
            .slice(-TRANSCRIPT_CHAR_CAP);

        try {
            const { text } = await generateText({
                model: modelFactory(input.model),
                instructions: EXTRACTION_SYSTEM,
                prompt: `## 已有记忆\n${manifest}\n\n## 最近对话\n${convo}`,
                maxOutputTokens: 1024,
                temperature: 0,
                abortSignal: input.signal
            });
            const ops = parseMemoryOps(text, hasProject);
            if (ops.length === 0) return;
            const result = await applyMemoryOps(ops, { projectId: input.projectId, sessionId: input.sessionId });
            if (result.written || result.deleted) {
                log.info('记忆抽取完成', { ...result, projectId: input.projectId });
            }
        } catch (err) {
            log.warn('记忆抽取失败（忽略）', { err });
        }
    }

    // ---------------- P2：dream 整理 ----------------

    let dreamLastScanAtMs = 0;
    let dreamRunning = false;

    function dreamLockPath(): string {
        return path.join(globalMemoryRoot(), DREAM_LOCK_FILE);
    }

    function isLiveProcess(pid: number): boolean {
        if (pid <= 1) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    /** 读上次整理时间（锁文件 mtime）。 */
    async function readLastConsolidatedAt(): Promise<number> {
        try {
            return (await fs.stat(dreamLockPath())).mtimeMs;
        } catch {
            return 0;
        }
    }

    /**
     * 取锁：仅当**别的**存活进程持有新鲜锁（<1h）时放弃；本进程自身的旧锁不拦截本进程
     * （同进程并发由 {@link dreamRunning} 内存标志拦截），否则「立即整理」会被上次遗留的自锁静默拦截 1 小时。
     * 成功返回 true。
     */
    async function acquireDreamLock(): Promise<boolean> {
        const lock = dreamLockPath();
        try {
            const [stat, content] = await Promise.all([fs.stat(lock), fs.readFile(lock, 'utf8')]);
            const pid = Number.parseInt(content.trim(), 10);
            if (
                pid !== process.pid &&
                Number.isFinite(pid) &&
                isLiveProcess(pid) &&
                Date.now() - stat.mtimeMs < 60 * 60 * 1000
            ) {
                return false;
            }
        } catch {
            // 无锁或不可读：按无主处理
        }
        await fs.mkdir(globalMemoryRoot(), { recursive: true });
        await fs.writeFile(lock, String(process.pid), 'utf8');
        return true;
    }

    const DREAM_SYSTEM = [
        '你是记忆整理子程序（dream）。下面是某一层已有的全部长期记忆（含正文）。',
        '请：合并重复或高度相近的条目；修正相互矛盾处（保留更可信/更新的）；删除明显过时或错误的；',
        '把相对日期改写为绝对日期。不要凭空新增对话之外的信息。',
        '\n输出一个 JSON 数组：对需要改写/合并后的条目用 {"action":"write",...completed fields...}（用被合并条目之一的 name 作为留存项）；',
        '对需要删除的条目用 {"action":"delete","name":"..."}。无需改动就输出 []。只输出 JSON，不要解释。',
        '所有条目都属于同一层，scope 固定为传入层，无需你指定。'
    ].join('');

    /** 整理单层：读全部记录 → LLM 合并/去重/纠错 → 应用。 */
    async function consolidateLayer(
        scope: 'global' | 'project',
        projectId: string | undefined,
        model: ResolvedModel
    ): Promise<void> {
        const store = getMemoryStore(resolveMemoryRoot(scope, projectId));
        const items = await store.list();
        if (items.length < DREAM_MIN_RECORDS) return;
        const records = await Promise.all(items.map((it) => store.read(it.name)));
        const dump = records
            .filter((r): r is NonNullable<typeof r> => !!r)
            .map((r) => `### ${r.name} [${r.type}]\n描述：${r.description}\n${r.content}`)
            .join('\n\n');

        try {
            const { text } = await generateText({
                model: modelFactory(model),
                instructions: DREAM_SYSTEM,
                prompt: `## 当前层：${scope}\n当前日期：${new Date().toISOString().slice(0, 10)}\n\n## 已有记忆\n${dump}`,
                maxOutputTokens: 2048,
                temperature: 0
            });
            const ops = parseMemoryOps(text, scope === 'project').map((op) => ({ ...op, scope }));
            if (ops.length === 0) return;
            const result = await applyMemoryOps(ops, { projectId });
            log.info('记忆整理完成', { scope, projectId, ...result });
        } catch (err) {
            log.warn('记忆整理失败（忽略）', { scope, err });
        }
    }

    /**
     * P2：触发 dream 整理。机会式——`force=false` 时经双闸（扫描节流 + 距上次 ≥24h）与进程锁，绝大多数调用廉价跳过；
     * `force=true`（设置页「立即整理」）跳过时间闸但仍走锁。整理全局层，有 projectId 时附带该项目层。
     */
    async function runMemoryDream(input: { projectId?: string; force?: boolean } = {}): Promise<void> {
        if (!settingsReader().enabled) return;
        const model = modelReader();
        if (!model) return;

        if (dreamRunning) return;
        // 回归证明：在异步取锁后才置位会让并发 force 请求同时通过，必须在首个 await 前占用护栏。
        dreamRunning = true;
        try {
            const now = Date.now();
            if (!input.force) {
                if (now - dreamLastScanAtMs < DREAM_SCAN_THROTTLE_MS) return;
                dreamLastScanAtMs = now;
                if (now - (await readLastConsolidatedAt()) < DREAM_MIN_INTERVAL_MS) return;
            }
            if (!(await acquireDreamLock())) return;
            await consolidateLayer('global', undefined, model);
            if (input.projectId) await consolidateLayer('project', input.projectId, model);
            // 刷新锁 mtime 作为「上次整理时间」
            await fs.writeFile(dreamLockPath(), String(process.pid), 'utf8').catch(() => {});
        } finally {
            dreamRunning = false;
        }
    }

    // 每会话抽取在途护栏：避免同一会话多轮并发抽取互相覆盖。
    const extracting = new Set<string>();

    /**
     * 轮结束后的记忆维护入口（P1 抽取 + P2 整理），由 chat onFinish fire-and-forget 调用。
     * 关闭记忆或无激活模型时直接返回；各步 best-effort，不抛错、不阻塞对话。
     */
    async function runMemoryMaintenance(input: {
        transcript: readonly TranscriptMessage[];
        projectId?: string;
        sessionId?: string;
    }): Promise<void> {
        const settings = settingsReader();
        if (!settings.enabled) return;
        const model = modelReader();
        if (!model) return;

        if (settings.autoExtract) {
            const key = input.sessionId ?? 'default';
            if (!extracting.has(key)) {
                extracting.add(key);
                try {
                    await runExtraction({ ...input, model });
                } finally {
                    extracting.delete(key);
                }
            }
        }

        if (settings.autoDream) {
            void runMemoryDream({ projectId: input.projectId });
        }
    }

    return { runMemoryDream, runMemoryMaintenance };
}

export const { runMemoryDream, runMemoryMaintenance } = createMemoryMaintenance();
