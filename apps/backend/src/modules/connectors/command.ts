import { execFile, spawn } from 'node:child_process';

import { buildStdioEnv, resolveStdioLaunch } from '@/platform/child-runtime';

export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}
export interface CommandOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    onOutput?: (text: string) => void;
}
export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

/** 连接器生命周期执行端口：参数数组直传、不经过 shell、不透传模型密钥。 */
export const runConnectorCommand: CommandRunner = (command, args, options = {}) =>
    new Promise((resolve) => {
        const launch = resolveStdioLaunch(command, args);
        const env = buildStdioEnv();
        if (launch.usesInternalNode) env.ELECTRON_RUN_AS_NODE = '1';
        const child = spawn(launch.command, launch.args ?? [], {
            env,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true
        });
        let stdout = '',
            stderr = '',
            size = 0,
            stopped = false;
        const kill = () => {
            if (!child.pid) return;
            if (process.platform === 'win32')
                execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
            else {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    child.kill('SIGKILL');
                }
            }
        };
        const stop = () => {
            stopped = true;
            kill();
        };
        const timer = setTimeout(stop, options.timeoutMs ?? 30_000);
        timer.unref();
        options.signal?.addEventListener('abort', stop, { once: true });
        if (options.signal?.aborted) stop();
        const receive = (chunk: Buffer, error: boolean) => {
            size += chunk.length;
            if (size > 256 * 1024) {
                stop();
                return;
            }
            const text = chunk.toString('utf8');
            if (error) stderr += text;
            else stdout += text;
            options.onOutput?.(stdout + '\n' + stderr);
        };
        child.stdout.on('data', (chunk: Buffer) => receive(chunk, false));
        child.stderr.on('data', (chunk: Buffer) => receive(chunk, true));
        const finish = (code: number) => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', stop);
            resolve({ code: stopped ? -1 : code, stdout, stderr });
        };
        child.once('error', () => finish(-1));
        child.once('close', (code) => finish(code ?? -1));
    });
