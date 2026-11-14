import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { paths, ensureDirSafe } from '@/config/paths';
import { getLogger } from '@/platform/logging/index';

/**
 * 「可恢复流」缓冲：内存为主 + 落盘兜底。
 *
 * 背景：本项目是 Electron 桌面壳 + 进程内 Node 后端架构，前端「刷新」只重载渲染进程(webview)、
 * 不重启后端(主进程)，所以进行中的流对象仍活在后端内存里。为此在 POST 流式时把 AI SDK
 * 旁路（consumeSseStream）teed 出来的 SSE 帧录入本缓冲；前端刷新/切回后经 GET 重连端点
 * 回放已产出的帧并追尾后续，实现「刷新可恢复」。
 *
 * 落盘兜底：每一帧同时追加写 `~/.zhuixun/streams/<chatId>.ndjson`（逐行 JSON），
 * 后端重启后内存虽空，但重连端点可从盘上回放已缓冲的帧到断点（随后关闭——模型侧已断，
 * 无法真正续算，前端据此回放到断点再读落库消息）。落盘失败只退化为纯内存，不影响主流。
 * 正常 onFinish 落库后由 TTL 回收磁盘文件；启动时清理过期残留。单进程单线程，无需加锁。
 */

/** 完成后保留缓冲的时长：兜住「刚结束就刷新」的重连，到期回收（内存与磁盘一致） */
const DONE_TTL_MS = 60_000;

/** 磁盘残留流文件的最长保留时长：启动清理时超过即删（兜重启后不再有人来重连的孤儿） */
const DISK_STALE_MS = 10 * 60_000;

interface Subscriber {
    enqueue: (frame: string) => void;
    close: () => void;
}

interface ActiveStream {
    chatId: string;
    /** 已产出的 SSE 字符串帧（形如 `data: {...}\n\n`），供重连时整段回放 */
    frames: string[];
    done: boolean;
    subscribers: Set<Subscriber>;
    evictTimer?: ReturnType<typeof setTimeout>;
    /** 落盘句柄；创建失败则为 undefined（退化为纯内存） */
    fileStream?: fs.WriteStream;
    filePath: string;
    reader?: ReadableStreamDefaultReader<string>;
    disposed?: boolean;
}

/** 把一帧编码为 ndjson 行 */
function encodeLine(frame: string): string {
    return `${JSON.stringify({ f: frame })}\n`;
}

/** 解析 ndjson 文件内容为帧数组 + 是否已完成 */
function decodeFile(content: string): { frames: string[]; done: boolean } {
    const frames: string[] = [];
    let done = false;
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const obj = JSON.parse(line) as { f?: string; done?: boolean };
            if (obj.done) done = true;
            else if (typeof obj.f === 'string') frames.push(obj.f);
        } catch {
            /* 跳过损坏行 */
        }
    }
    return { frames, done };
}

class ResumableStreamStore {
    private streams = new Map<string, ActiveStream>();

    /**
     * POST 流式时调用：把 tee 出来的 SSE 字符串流录入缓冲并实时广播给已重连的订阅者。
     * 同一会话串行发送（前端 send 有并发守卫），新一轮流直接覆盖旧缓冲。
     */
    record(chatId: string, sse: ReadableStream<string>): void {
        void this.evict(chatId);
        const filePath = paths.streamFile(chatId);
        let fileStream: fs.WriteStream | undefined;
        try {
            ensureDirSafe(paths.streamsDir(), 'resumable-stream');
            fs.rmSync(filePath, { force: true });
            // 同步打开文件，确保旧录制被清理后不会延迟 open、覆盖新一轮的缓冲文件。
            fileStream = fs.createWriteStream(filePath, { fd: fs.openSync(filePath, 'w', 0o600) });
            fileStream.on('error', (err) => {
                getLogger('ResumableStream').warn('流落盘失败，退化为纯内存', { chatId, err: err.message });
            });
        } catch (err) {
            getLogger('ResumableStream').warn('创建流落盘文件失败，退化为纯内存', {
                chatId,
                err: err instanceof Error ? err.message : err
            });
        }
        const entry: ActiveStream = { chatId, frames: [], done: false, subscribers: new Set(), fileStream, filePath };
        this.streams.set(chatId, entry);
        void this.pump(entry, sse);
    }

    private async pump(entry: ActiveStream, sse: ReadableStream<string>): Promise<void> {
        const reader = sse.getReader();
        entry.reader = reader;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done || entry.disposed) break;
                if (typeof value !== 'string') continue;
                entry.frames.push(value);
                entry.fileStream?.write(encodeLine(value));
                for (const sub of entry.subscribers) sub.enqueue(value);
            }
        } catch (err) {
            getLogger('ResumableStream').warn('录制流中断', { chatId: entry.chatId, err });
        } finally {
            reader.releaseLock();
            entry.reader = undefined;
            this.finish(entry);
        }
    }

    private finish(entry: ActiveStream): void {
        // 被替换/释放的旧 pump 仍可能在 await read 后返回，不能给新 entry 安排过期清理。
        if (entry.done || entry.disposed) return;
        entry.done = true;
        try {
            entry.fileStream?.write(`${JSON.stringify({ done: true })}\n`);
            entry.fileStream?.end();
        } catch {
            /* 落盘收尾失败忽略 */
        }
        for (const sub of entry.subscribers) sub.close();
        entry.subscribers.clear();
        entry.evictTimer = setTimeout(() => void this.evict(entry.chatId), DONE_TTL_MS);
    }

    /**
     * GET 重连：
     * - 内存有缓冲：整段回放已产出帧，未完成则挂订阅者追尾，完成则回放后关闭。
     * - 内存无缓冲（如后端重启）：尝试从盘上回放，回放完即关闭（无法续算）。
     * - 盘上也没有：返回 null（端点据此回 204，前端读落库消息）。
     */
    reconnect(chatId: string): ReadableStream<Uint8Array> | null {
        const entry = this.streams.get(chatId);
        if (!entry) return this.reconnectFromDisk(chatId);
        const encoder = new TextEncoder();
        let sub: Subscriber | null = null;
        return new ReadableStream<Uint8Array>({
            start: (controller) => {
                for (const frame of entry.frames) controller.enqueue(encoder.encode(frame));
                if (entry.done) {
                    controller.close();
                    return;
                }
                sub = {
                    enqueue: (frame) => {
                        try {
                            controller.enqueue(encoder.encode(frame));
                        } catch {
                            /* 控制器已关闭：忽略 */
                        }
                    },
                    close: () => {
                        try {
                            controller.close();
                        } catch {
                            /* 已关闭：忽略 */
                        }
                    }
                };
                entry.subscribers.add(sub);
            },
            cancel: () => {
                if (sub) entry.subscribers.delete(sub);
            }
        });
    }

    /** 从盘上回放一条流的已缓冲帧（后端重启后内存为空时的兜底），回放后即关闭。 */
    private reconnectFromDisk(chatId: string): ReadableStream<Uint8Array> | null {
        let content: string;
        try {
            content = fs.readFileSync(paths.streamFile(chatId), 'utf8');
        } catch {
            return null; // 盘上也没有
        }
        const { frames } = decodeFile(content);
        if (frames.length === 0) return null;
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
            start: (controller) => {
                for (const frame of frames) controller.enqueue(encoder.encode(frame));
                controller.close();
            }
        });
    }

    /** 当前进行中的会话 id 列表（供前端刷新后在侧栏显示「生成中」） */
    getActiveIds(): string[] {
        const ids: string[] = [];
        for (const [chatId, entry] of this.streams) if (!entry.done) ids.push(chatId);
        return ids;
    }

    /** 释放当前实例持有的 reader、timer 与文件句柄；保留盘上缓冲，供重启后回放。 */
    async dispose(): Promise<void> {
        await Promise.all([...this.streams.keys()].map((chatId) => this.evict(chatId, false)));
    }

    /** 关闭订阅者、移除内存缓冲；unlink 必须在新一轮同步建文件之前完成。 */
    private async evict(chatId: string, removeFile = true): Promise<void> {
        const entry = this.streams.get(chatId);
        if (!entry) return;
        entry.disposed = true;
        if (entry.evictTimer) clearTimeout(entry.evictTimer);
        const cancelled = entry.reader?.cancel().catch(() => {});
        const closed = entry.fileStream
            ? new Promise<void>((resolve) => {
                  if (entry.fileStream!.closed) return resolve();
                  entry.fileStream!.once('close', resolve);
                  entry.fileStream!.end();
              })
            : undefined;
        if (removeFile) {
            try {
                // 异步 rm 会与同 chatId 的新录制竞争，误删新文件；先 unlink，旧 fd 自行收尾。
                fs.rmSync(entry.filePath, { force: true });
            } catch {
                /* 清理失败不影响内存回放 */
            }
        }
        for (const sub of entry.subscribers) sub.close();
        entry.subscribers.clear();
        this.streams.delete(chatId);
        await Promise.all([cancelled, closed]);
    }
}

/** 启动时清理 streams 目录下过期/孤儿的流文件（上次运行遗留）。幂等、失败只告警。 */
export async function cleanupStaleStreamFiles(): Promise<void> {
    const dir = paths.streamsDir();
    let names: string[];
    try {
        names = await fsp.readdir(dir);
    } catch {
        return; // 目录不存在：无需清理
    }
    const now = Date.now();
    await Promise.all(
        names
            .filter((n) => n.endsWith('.ndjson'))
            .map(async (n) => {
                const fp = path.join(dir, n);
                try {
                    const stat = await fsp.stat(fp);
                    if (now - stat.mtimeMs > DISK_STALE_MS) await fsp.rm(fp, { force: true });
                } catch {
                    /* 单文件失败忽略 */
                }
            })
    );
}

/** 独立生命周期入口，避免嵌入方/测试共享单例的计时器与文件句柄。 */
export function createResumableStreamStore(): ResumableStreamStore {
    return new ResumableStreamStore();
}

let store: ResumableStreamStore | null = null;

/** 获取可恢复流缓冲单例 */
export function getResumableStreamStore(): ResumableStreamStore {
    if (!store) store = new ResumableStreamStore();
    return store;
}
