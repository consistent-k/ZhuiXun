import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runConnectorCommand } from '@/modules/connectors/command';

const processMock = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', () => processMock);

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});
function child() {
    const emitter = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        pid?: number;
        kill: ReturnType<typeof vi.fn>;
    };
    emitter.stdout = new PassThrough();
    emitter.stderr = new PassThrough();
    emitter.pid = 123456;
    emitter.kill = vi.fn();
    processMock.spawn.mockReturnValue(emitter);
    return emitter;
}
describe('连接器进程执行边界', () => {
    it('参数不经过 shell，过滤服务端密钥并传递内部 Node 标志', async () => {
        vi.stubEnv('CONNECTOR_PRIVATE_MODEL_KEY', 'fixture-secret');
        const proc = child();
        const result = runConnectorCommand('node', ['fixture.js', 'value; no shell expansion']);
        const [command, args, options] = processMock.spawn.mock.calls.at(-1)!;
        expect(command).toBe(process.execPath);
        expect(args).toEqual(['fixture.js', 'value; no shell expansion']);
        expect(options.shell).toBe(false);
        expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
        expect(options.env.CONNECTOR_PRIVATE_MODEL_KEY).toBeUndefined();
        proc.stdout.emit('data', Buffer.from('ok'));
        proc.emit('close', 0);
        expect(await result).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    });
    it('超时与取消会终止进程组，超量输出不会无限占用内存', async () => {
        vi.useFakeTimers();
        const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
        const proc = child();
        const controller = new AbortController();
        const result = runConnectorCommand('node', ['fixture.js'], { signal: controller.signal, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-123456, 'SIGKILL');
        proc.emit('close', null);
        expect((await result).code).toBe(-1);
        const proc2 = child();
        const result2 = runConnectorCommand('node', ['fixture.js'], { signal: controller.signal });
        controller.abort();
        proc2.emit('close', null);
        expect((await result2).code).toBe(-1);
        const proc3 = child();
        const result3 = runConnectorCommand('node', ['fixture.js']);
        proc3.stdout.emit('data', Buffer.alloc(300 * 1024));
        proc3.emit('close', null);
        expect(await result3).toMatchObject({ code: -1, stdout: '' });
    });
});
