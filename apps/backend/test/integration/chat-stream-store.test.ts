import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import {
    cleanupStaleStreamFiles,
    createResumableStreamStore,
    getResumableStreamStore
} from '@/modules/chat/stream-store';

vi.mock('@/platform/logging/index', () => ({ getLogger: () => ({ warn: vi.fn() }) }));

let root: string;
let store: ReturnType<typeof createResumableStreamStore>;
let oldDir: string | undefined;

async function text(stream: ReadableStream<Uint8Array> | null): Promise<string> {
    expect(stream).not.toBeNull();
    return new Response(stream).text();
}

function source() {
    let controller: ReadableStreamDefaultController<string>;
    const cancel = vi.fn();
    const stream = new ReadableStream<string>({
        start(c) {
            controller = c;
        },
        cancel
    });
    return {
        stream,
        cancel,
        get controller() {
            return controller;
        }
    };
}

async function finished() {
    await vi.waitFor(() => expect(store.getActiveIds()).toEqual([]));
}

beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-stream-'));
    oldDir = process.env.STREAMS_USER_DIR;
    process.env.STREAMS_USER_DIR = root;
    store = createResumableStreamStore();
});

afterEach(async () => {
    vi.useRealTimers();
    await store.dispose();
    vi.restoreAllMocks();
    if (oldDir === undefined) delete process.env.STREAMS_USER_DIR;
    else process.env.STREAMS_USER_DIR = oldDir;
    await fsp.rm(root, { recursive: true, force: true });
});

describe('resumable stream lifecycle', () => {
    it('keeps the production getter singleton while factories own separate lifetimes', async () => {
        expect(getResumableStreamStore()).toBe(getResumableStreamStore());
        expect(store).not.toBe(createResumableStreamStore());
        await getResumableStreamStore().dispose();
    });

    it('records, replays buffered frames and tails new frames; disconnect does not cancel the producer', async () => {
        const input = source();
        store.record('chat', input.stream);
        input.controller.enqueue('data: first\n\n');
        await vi.waitFor(() => expect(fs.readFileSync(paths.streamFile('chat'), 'utf8')).toContain('first'));
        expect(store.getActiveIds()).toEqual(['chat']);
        const reader = store.reconnect('chat')!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
        input.controller.enqueue('data: second\n\n');
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: second\n\n');
        await reader.cancel();
        expect(input.cancel).not.toHaveBeenCalled();
        input.controller.close();
        await finished();
        expect(await text(store.reconnect('chat'))).toBe('data: first\n\ndata: second\n\n');
        await store.dispose();
        const diskOnly = createResumableStreamStore();
        expect(await text(diskOnly.reconnect('chat'))).toBe('data: first\n\ndata: second\n\n');
        await diskOnly.dispose();
    });

    it('disposes live readers/subscribers and flushes file handles without deleting replay files', async () => {
        const input = source();
        store.record('chat', input.stream);
        const reader = store.reconnect('chat')!.getReader();
        input.controller.enqueue('saved');
        expect((await reader.read()).done).toBe(false);
        await store.dispose();
        expect(input.cancel).toHaveBeenCalledOnce();
        expect((await reader.read()).done).toBe(true);
        expect(store.getActiveIds()).toEqual([]);
        expect(await fsp.readFile(paths.streamFile('chat'), 'utf8')).toContain('saved');
        await store.dispose();
    });

    it('replacing a live recording cannot let its old pump delete or expire the replacement', async () => {
        const first = source();
        store.record('chat', first.stream);
        const reader = store.reconnect('chat')!.getReader();
        const next = source();
        store.record('chat', next.stream);
        expect((await reader.read()).done).toBe(true);
        next.controller.enqueue('replacement');
        await vi.waitFor(() => expect(fs.readFileSync(paths.streamFile('chat'), 'utf8')).toContain('replacement'));
        expect(first.cancel).toHaveBeenCalledOnce();
        expect(store.getActiveIds()).toEqual(['chat']);
        next.controller.close();
        await finished();
        await store.dispose();
        expect(await text(store.reconnect('chat'))).toBe('replacement');
    });

    it('evicts completed recordings at TTL, but not while still active', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const input = source();
        store.record('chat', input.stream);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(store.getActiveIds()).toEqual(['chat']);
        input.controller.enqueue('frame');
        input.controller.close();
        await vi.advanceTimersByTimeAsync(1);
        expect(store.getActiveIds()).toEqual([]);
        expect(await text(store.reconnect('chat'))).toBe('frame');
        await vi.advanceTimersByTimeAsync(59_999);
        expect(store.reconnect('chat')).toBeNull();
        expect(fs.existsSync(paths.streamFile('chat'))).toBe(false);
    });

    it('ignores non-string values and keeps partial frames after producer failure', async () => {
        const input = source();
        store.record('chat', input.stream);
        input.controller.enqueue('partial');
        input.controller.enqueue(12 as unknown as string);
        await vi.waitFor(() => expect(fs.readFileSync(paths.streamFile('chat'), 'utf8')).toContain('partial'));
        input.controller.error(new Error('producer stopped'));
        await finished();
        expect(await text(store.reconnect('chat'))).toBe('partial');
    });

    it('falls back to memory when the target directory is not writable', async () => {
        const file = path.join(root, 'not-a-directory');
        await fsp.writeFile(file, 'blocked');
        process.env.STREAMS_USER_DIR = file;
        const input = source();
        store.record('chat', input.stream);
        input.controller.enqueue('memory-only');
        input.controller.close();
        await finished();
        expect(await text(store.reconnect('chat'))).toBe('memory-only');
    });

    it('falls back on asynchronous write errors without breaking broadcast', async () => {
        const realCreate = fs.createWriteStream;
        vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
            const stream = realCreate(...args);
            queueMicrotask(() => stream.destroy(new Error('disk full')));
            return stream;
        });
        const input = source();
        store.record('chat', input.stream);
        input.controller.enqueue('still-visible');
        input.controller.close();
        await finished();
        expect(await text(store.reconnect('chat'))).toBe('still-visible');
    });

    it('skips corrupt and non-frame disk lines, handles missing/empty files', async () => {
        expect(store.reconnect('missing')).toBeNull();
        await fsp.writeFile(
            paths.streamFile('chat'),
            '\nnot json\n{"x":1}\n{"f":7}\n{"f":"a"}\n{"done":true}\n{"f":"b"}\n'
        );
        expect(await text(store.reconnect('chat'))).toBe('ab');
        await fsp.writeFile(paths.streamFile('chat'), '{"done":true}\n');
        expect(store.reconnect('chat')).toBeNull();
    });

    it('cleans stale ndjson files only, tolerates missing directories and individual stat failures', async () => {
        const stale = paths.streamFile('stale');
        const fresh = paths.streamFile('fresh');
        const other = path.join(root, 'keep.txt');
        await Promise.all([fsp.writeFile(stale, 'old'), fsp.writeFile(fresh, 'new'), fsp.writeFile(other, 'keep')]);
        await fsp.symlink(path.join(root, 'absent'), path.join(root, 'broken.ndjson'));
        const old = new Date(Date.now() - 601_000);
        await fsp.utimes(stale, old, old);
        await fsp.utimes(other, old, old);
        await cleanupStaleStreamFiles();
        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
        process.env.STREAMS_USER_DIR = path.join(root, 'absent');
        await expect(cleanupStaleStreamFiles()).resolves.toBeUndefined();
    });
});
