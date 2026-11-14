import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { claimBackendInstance } from '@/bootstrap/instance';
import { ZHUIXUN_HOME } from '@/config/paths';

it('recovers a dead backend claim without removing an active owner', async () => {
    const directory = path.join(ZHUIXUN_HOME, 'runtime');
    const claims = path.join(directory, 'backend-claims');
    const deadPid = process.pid + 1;
    const deadClaim = path.join(claims, `${deadPid}-00000000-0000-0000-0000-000000000000`);
    await fs.mkdir(deadClaim, { recursive: true });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
        if (pid === deadPid) throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
        return true;
    });
    try {
        const owner = await claimBackendInstance();
        try {
            await owner.publish(31001, 'first');
            await expect(fs.stat(deadClaim)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(claimBackendInstance()).rejects.toThrow('已有 追寻 后端');
            expect(await fs.readdir(claims)).toHaveLength(1);
            expect(JSON.parse(await fs.readFile(path.join(directory, 'backend.json'), 'utf8'))).toMatchObject({
                instanceId: 'first'
            });
        } finally {
            await owner.release();
        }
        const next = await claimBackendInstance();
        await next.release();
        expect(await fs.readdir(claims)).toEqual([]);
    } finally {
        kill.mockRestore();
    }
});
