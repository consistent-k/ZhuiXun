import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 原子写与 JSON 读写原语。
 *
 * 背景：改造前这套「写临时文件 → rename」在 9 个 store 里各写一遍，失败清理行为还不一致
 * （checkpoint-store 失败会残留 .tmp）。这里收成唯一实现，业务语义（时间戳保留、标题锁、
 * 快照冻结）仍留在各自 store，不下沉。
 */

/** 临时文件名：带 pid 与随机后缀，避免同目录多进程/多并发互相覆盖。 */
function tmpName(file: string): string {
    return `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

/**
 * 原子写文件：写同目录临时文件 → rename。失败时清理临时文件再把原错误抛出。
 * rename 在同一文件系统内是原子的，读方要么看到旧内容、要么看到新内容，不会读到半个文件。
 */
export async function writeFileAtomic(
    file: string,
    data: string | Uint8Array,
    opts: { mode?: number } = {}
): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = tmpName(file);
    try {
        await fsp.writeFile(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
        await fsp.rename(tmp, file);
    } catch (error) {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
    }
}

/** 原子写 JSON（2 空格缩进 + 末尾换行，保持与现有落盘文件一致）。 */
export async function writeJsonAtomic(file: string, value: unknown, opts: { mode?: number } = {}): Promise<void> {
    await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, opts);
}

/**
 * 同步原子写：仅供启动引导链（bootstrap-settings）使用——它必须早于异步初始化完成，
 * 不能把引导改成异步。其他位置一律用异步版本。
 */
export function writeFileAtomicSync(file: string, data: string, opts: { mode?: number } = {}): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = tmpName(file);
    try {
        fs.writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
        fs.renameSync(tmp, file);
    } catch (error) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            // 清理失败不应覆盖原始错误
        }
        throw error;
    }
}

/** 同步原子写 JSON（引导链专用）。 */
export function writeJsonAtomicSync(file: string, value: unknown, opts: { mode?: number } = {}): void {
    writeFileAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`, opts);
}

/**
 * 读 JSON：文件不存在返回 fallback。
 * `onParseError: 'fallback'`（默认）时解析失败也返回 fallback 并调用 onError；
 * `'throw'` 时解析失败原样抛出，供「索引损坏要重建」这类调用方自行处理。
 */
export async function readJson<T>(
    file: string,
    fallback: T,
    opts: { onParseError?: 'fallback' | 'throw'; onError?: (error: unknown) => void } = {}
): Promise<T> {
    let raw: string;
    try {
        raw = await fsp.readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
        throw error;
    }
    try {
        return JSON.parse(raw) as T;
    } catch (error) {
        opts.onError?.(error);
        if (opts.onParseError === 'throw') throw error;
        return fallback;
    }
}

/** 读 JSON 文本；文件不存在返回 null。 */
export async function readText(file: string): Promise<string | null> {
    try {
        return await fsp.readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * 串行队列：把 READ-MODIFY-WRITE 整段放进队列，避免并发调用交叉覆盖。
 * 任务失败不会中断后续任务（队列自身始终回到 resolved 状态）。
 */
export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.tail.then(fn);
        this.tail = next.catch(() => undefined);
        return next;
    }
}
