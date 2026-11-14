import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TempData {
    root: string;
    memory: string;
    sessions: string;
    projects: string;
    tasks: string;
    permissions: string;
    streams: string;
    skills: string;
    audit: string;
    cleanup: () => Promise<void>;
}

export async function createTempData(prefix = 'zhuixun-test-'): Promise<TempData> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const dirs = {
        memory: path.join(root, 'memory'),
        sessions: path.join(root, 'sessions'),
        projects: path.join(root, 'projects'),
        tasks: path.join(root, 'tasks'),
        permissions: path.join(root, 'permissions'),
        streams: path.join(root, 'streams'),
        skills: path.join(root, 'skills'),
        audit: path.join(root, 'audit')
    };

    return {
        root,
        ...dirs,
        cleanup: async () => {
            await fs.rm(root, { recursive: true, force: true });
        }
    };
}
