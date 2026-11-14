import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '@/config/atomic-json';
import { ZHUIXUN_HOME } from '@/config/paths';

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // 只有 ESRCH 证明进程已退出，权限不足时仍视为占用。
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
    }
}

export async function claimBackendInstance() {
    const directory = path.join(ZHUIXUN_HOME, 'runtime');
    const claims = path.join(directory, 'backend-claims');
    const legacyLock = path.join(directory, 'backend.lock');
    const descriptor = path.join(directory, 'backend.json');
    await fs.mkdir(claims, { recursive: true, mode: 0o700 });

    const legacyOwner = await fs.readFile(legacyLock, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
    });
    if (legacyOwner !== undefined) {
        const pid = Number(legacyOwner);
        if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) {
            throw new Error('旧版 追寻 后端锁仍被占用，请检查 runtime/backend.lock');
        }
        await fs.rm(legacyLock, { force: true });
    }

    const name = `${process.pid}-${randomUUID()}`;
    const claim = path.join(claims, name);
    await fs.mkdir(claim, { mode: 0o700 });
    try {
        // 先声明再扫描。并发启动可能同时退出，但不能同时拿到所有权。只清理已退出进程的独立声明。
        for (const entry of await fs.readdir(claims)) {
            const match = /^(\d+)-[a-f0-9-]+$/.exec(entry);
            if (!match || entry === name) continue;
            const pid = Number(match[1]);
            if (!Number.isSafeInteger(pid) || pid <= 0) continue;
            if (isAlive(pid)) throw new Error('已有 追寻 后端正在启动或运行，请连接已有实例');
            await fs.rm(path.join(claims, entry), { recursive: true, force: true });
        }
    } catch (error) {
        await fs.rm(claim, { recursive: true, force: true });
        throw error;
    }

    return {
        publish: (port: number, instanceId?: string) =>
            writeJsonAtomic(descriptor, { protocol: 1, pid: process.pid, port, instanceId }, { mode: 0o600 }),
        async release() {
            await fs.rm(descriptor, { force: true });
            await fs.rm(claim, { recursive: true, force: true });
        }
    };
}
