import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Backend {
    port: number;
    close(): Promise<void>;
}

function loopback(value: string): string {
    const url = new URL(value);
    if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.href !== url.origin + '/'
    ) {
        throw new Error('后端地址必须是回环 HTTP origin，例如 http://127.0.0.1:31001');
    }
    return url.origin;
}

export class Api {
    readonly headers: Record<string, string> = process.env.API_AUTH_TOKEN
        ? { 'x-zhuixun-token': process.env.API_AUTH_TOKEN }
        : {};

    constructor(readonly origin: string) {}

    async request<T>(endpoint: string, init?: RequestInit): Promise<T> {
        const response = await fetch(this.origin + endpoint, {
            ...init,
            redirect: 'error',
            headers: {
                ...this.headers,
                ...(typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {})
            }
        });
        const data = (await response.json()) as { code: number; data: T; message?: string };
        if (!response.ok || data.code !== 0) throw new Error(data.message ?? `HTTP ${response.status}`);
        return data.data;
    }

    post<T>(endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
        return this.request(endpoint, {
            method: 'POST',
            body: payload === undefined ? undefined : JSON.stringify(payload),
            signal
        });
    }
}

async function ensureReady(origin: string, instanceId?: string): Promise<void> {
    const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const status = (await response.json()) as { ready?: boolean; permissionBaseline?: string; instanceId?: string };
    if (
        !response.ok ||
        status.ready !== true ||
        !status.permissionBaseline ||
        (instanceId && status.instanceId !== instanceId)
    ) {
        throw new Error('追寻 后端尚未就绪');
    }
}

export async function connect(explicit?: string): Promise<{ api: Api; owned?: Backend }> {
    let instanceId: string | undefined;
    let origin = explicit ? loopback(explicit) : undefined;
    if (!origin) {
        const descriptor = path.join(os.homedir(), '.zhuixun', 'runtime', 'backend.json');
        const raw = await readFile(descriptor, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
        });
        if (raw) {
            const info = JSON.parse(raw) as { port: number; protocol: number; pid: number; instanceId?: string };
            if (info.protocol !== 1 || !Number.isInteger(info.port) || !Number.isInteger(info.pid) || info.pid <= 0) {
                throw new Error('追寻 后端实例信息无效');
            }
            try {
                process.kill(info.pid, 0);
                instanceId = info.instanceId;
                origin = loopback(`http://127.0.0.1:${info.port}`);
            } catch (error) {
                // 旧实例已退出时交给后端回收锁，CLI 不直接删除实例文件。
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
        }
    }
    if (origin) {
        await ensureReady(origin, instanceId);
        return { api: new Api(origin) };
    }

    process.env.ZHUIXUN_LOG_CONSOLE ??= '0';
    process.env.LOG_TO_FILE ??= 'true';
    const entry = new URL('./server.js', import.meta.url).href;
    const backend = (await import(entry)) as {
        startServer(plugins: Readonly<Record<string, string>>): Promise<Backend>;
    };
    const owned = await backend.startServer({
        telegram: fileURLToPath(new URL('./plugins/telegram.js', import.meta.url)),
        weixin: fileURLToPath(new URL('./plugins/weixin.js', import.meta.url))
    });
    const api = new Api(`http://127.0.0.1:${owned.port}`);
    try {
        await ensureReady(api.origin);
        return { api, owned };
    } catch (error) {
        await owned.close();
        throw error;
    }
}
