import syncFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    SerialQueue,
    readJson,
    readText,
    writeFileAtomic,
    writeFileAtomicSync,
    writeJsonAtomic,
    writeJsonAtomicSync
} from '@/config/atomic-json';

import { createTempData } from '../helpers/temp-data';

afterEach(() => vi.restoreAllMocks());

describe('atomic JSON primitives', () => {
    it('writes JSON atomically and reads it back without temporary files', async () => {
        const temp = await createTempData();
        try {
            const file = path.join(temp.root, 'nested', 'value.json');
            await writeJsonAtomic(file, { version: 1, values: ['a', 'b'] });
            await expect(readJson(file, null)).resolves.toEqual({ version: 1, values: ['a', 'b'] });
            await expect(fs.readdir(path.dirname(file))).resolves.toEqual(['value.json']);
            await writeFileAtomic(file, new Uint8Array([65, 66]), { mode: 0o600 });
            await expect(readText(file)).resolves.toBe('AB');
            writeFileAtomicSync(file, 'sync');
            expect(syncFs.readFileSync(file, 'utf8')).toBe('sync');
            writeJsonAtomicSync(file, { sync: true }, { mode: 0o600 });
            expect(syncFs.readFileSync(file, 'utf8')).toBe('{\n  "sync": true\n}\n');
        } finally {
            await temp.cleanup();
        }
    });

    it('returns fallback only for absent files or malformed JSON and reports parse errors', async () => {
        const temp = await createTempData();
        try {
            const file = path.join(temp.root, 'value.json');
            await expect(readJson(file, { missing: true })).resolves.toEqual({ missing: true });
            await expect(readText(file)).resolves.toBeNull();
            await fs.writeFile(file, '{broken');
            const onError = vi.fn();
            await expect(readJson(file, [], { onError })).resolves.toEqual([]);
            expect(onError).toHaveBeenCalledWith(expect.any(SyntaxError));
            await expect(readJson(file, null, { onParseError: 'throw' })).rejects.toBeInstanceOf(SyntaxError);
            const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
            vi.spyOn(fs, 'readFile').mockRejectedValue(denied);
            await expect(readJson(file, null)).rejects.toBe(denied);
            await expect(readText(file)).rejects.toBe(denied);
        } finally {
            await temp.cleanup();
        }
    });

    it.each(['write', 'rename'] as const)(
        'preserves the old file and cleans temp files after async %s failure',
        async (stage) => {
            const temp = await createTempData();
            try {
                const file = path.join(temp.root, 'value.json');
                await fs.writeFile(file, 'old');
                const failure = new Error(stage);
                if (stage === 'write') vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure);
                else vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure);
                await expect(writeFileAtomic(file, 'new')).rejects.toBe(failure);
                expect(await fs.readFile(file, 'utf8')).toBe('old');
                expect(await fs.readdir(temp.root)).toEqual(['value.json']);
            } finally {
                await temp.cleanup();
            }
        }
    );

    it('keeps the original async failure even if cleanup also fails', async () => {
        const temp = await createTempData();
        try {
            const failure = new Error('write failure');
            vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure);
            vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('cleanup failure'));
            await expect(writeFileAtomic(path.join(temp.root, 'value'), 'new')).rejects.toBe(failure);
        } finally {
            await temp.cleanup();
        }
    });

    it.each([false, true])('keeps the original sync failure when cleanup fails: %s', async (cleanupFails) => {
        const temp = await createTempData();
        try {
            const file = path.join(temp.root, 'value');
            syncFs.writeFileSync(file, 'old');
            const failure = new Error('rename failure');
            vi.spyOn(syncFs, 'renameSync').mockImplementationOnce(() => {
                throw failure;
            });
            if (cleanupFails)
                vi.spyOn(syncFs, 'rmSync').mockImplementationOnce(() => {
                    throw new Error('cleanup');
                });
            expect(() => writeFileAtomicSync(file, 'new')).toThrow(failure);
            expect(syncFs.readFileSync(file, 'utf8')).toBe('old');
            if (!cleanupFails) expect(await fs.readdir(temp.root)).toEqual(['value']);
        } finally {
            await temp.cleanup();
        }
    });

    it('serializes concurrent operations and continues after failure', async () => {
        const queue = new SerialQueue();
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = queue.run(async () => {
            order.push('first');
            await gate;
            order.push('done');
            return 1;
        });
        const failed = queue.run(async () => {
            order.push('failed');
            throw new Error('expected');
        });
        const after = queue.run(async () => {
            order.push('after');
            return 3;
        });
        await Promise.resolve();
        expect(order).toEqual(['first']);
        release();
        await expect(first).resolves.toBe(1);
        await expect(failed).rejects.toThrow('expected');
        await expect(after).resolves.toBe(3);
        expect(order).toEqual(['first', 'done', 'failed', 'after']);
    });
});
