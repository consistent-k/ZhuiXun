import type { Channel, ChannelStartOpts } from '@zhuixun/channels-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { channelManager } from '@/modules/channels';
import { flushLogs } from '@/platform/logging/index';

let sequence = 0;
function fakeChannel() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    const finished = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    const channel: Channel = {
        id: `lifecycle-${++sequence}`,
        name: '测试渠道',
        status: 'idle',
        isConfigured: vi.fn(() => true),
        getStatusInfo: vi.fn(() => []),
        start: vi.fn(({ abortSignal }: ChannelStartOpts) => {
            signal = abortSignal;
            return finished;
        }),
        stop: vi.fn(async () => {
            resolve();
        })
    };
    return { channel, resolve, reject, signal: () => signal };
}

afterEach(async () => {
    await channelManager.stopAll();
    await flushLogs();
    vi.restoreAllMocks();
});

describe('宿主 channelManager 生命周期', () => {
    it('拒绝未知或未配置渠道，重复注册保留原实例', async () => {
        await expect(channelManager.start('never-registered')).rejects.toThrow('未注册');
        await expect(channelManager.stop('never-registered')).rejects.toThrow('未注册');
        expect(channelManager.get('never-registered')).toBeUndefined();
        expect(channelManager.isRunning('never-registered')).toBe(false);
        expect(channelManager.getUptime('never-registered')).toBe(0);

        const { channel } = fakeChannel();
        vi.mocked(channel.isConfigured).mockReturnValue(false);
        channelManager.register(channel);
        channelManager.register({ ...channel, name: '不得替换' });
        expect(channelManager.get(channel.id)).toBe(channel);
        expect(channelManager.list().filter(({ id }) => id === channel.id)).toEqual([channel]);
        await expect(channelManager.start(channel.id)).rejects.toThrow('未配置');
        expect(channel.start).not.toHaveBeenCalled();
        expect(channelManager.isRunning(channel.id)).toBe(false);
        await channelManager.stop(channel.id);
        expect(channel.stop).not.toHaveBeenCalled();
    });

    it('start 不等待后台任务结束；重复 start 拒绝，停止 abort 后幂等且可重启', async () => {
        const fake = fakeChannel();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
        channelManager.register(fake.channel);
        await channelManager.start(fake.channel.id);
        expect(fake.channel.status).toBe('running');
        expect(fake.channel.start).toHaveBeenCalledExactlyOnceWith({ abortSignal: fake.signal() });
        clock.mockReturnValue(10_250);
        expect(channelManager.getUptime(fake.channel.id)).toBe(250);
        await expect(channelManager.start(fake.channel.id)).rejects.toThrow('已在运行');
        expect(fake.signal()!.aborted).toBe(false);

        await channelManager.stop(fake.channel.id);
        expect(fake.signal()!.aborted).toBe(true);
        expect(fake.channel.status).toBe('idle');
        expect(channelManager.getUptime(fake.channel.id)).toBe(0);
        expect(channelManager.isRunning(fake.channel.id)).toBe(false);
        await channelManager.stop(fake.channel.id);
        expect(fake.channel.stop).toHaveBeenCalledTimes(1);

        let finishRestart!: () => void;
        vi.mocked(fake.channel.start).mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishRestart = resolve;
                })
        );
        await channelManager.start(fake.channel.id);
        expect(channelManager.isRunning(fake.channel.id)).toBe(true);
        expect(fake.channel.status).toBe('running');
        finishRestart();
        await vi.waitFor(() => expect(channelManager.isRunning(fake.channel.id)).toBe(false));
        expect(fake.channel.status).toBe('idle');
        expect(fake.channel.start).toHaveBeenCalledTimes(2);
    });

    it('后台正常结束重置状态，异常退出保留 error 并记录原因', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const normal = fakeChannel();
        const failed = fakeChannel();
        channelManager.register(normal.channel);
        channelManager.register(failed.channel);
        await channelManager.start(normal.channel.id);
        await channelManager.start(failed.channel.id);
        normal.resolve();
        failed.reject(new Error('fake provider crashed'));
        await vi.waitFor(() => {
            expect(channelManager.isRunning(normal.channel.id)).toBe(false);
            expect(channelManager.isRunning(failed.channel.id)).toBe(false);
        });
        expect(normal.channel.status).toBe('idle');
        expect(failed.channel.status).toBe('error');
        expect(channelManager.getUptime(failed.channel.id)).toBe(0);
        expect(errors.mock.calls.some(([line]) => String(line).includes('渠道运行异常退出'))).toBe(true);
    });

    it('异步 stop 失败只告警；stopAll 仍停止其他渠道', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failed = fakeChannel();
        const normal = fakeChannel();
        vi.mocked(failed.channel.stop).mockImplementation(async () => {
            failed.resolve();
            throw new Error('fake stop failure');
        });
        channelManager.register(failed.channel);
        channelManager.register(normal.channel);
        await channelManager.start(failed.channel.id);
        await channelManager.start(normal.channel.id);
        await channelManager.stopAll();
        for (const fake of [failed, normal]) {
            expect(fake.signal()!.aborted).toBe(true);
            expect(fake.channel.status).toBe('idle');
            expect(channelManager.isRunning(fake.channel.id)).toBe(false);
            expect(fake.channel.stop).toHaveBeenCalledTimes(1);
        }
        expect(errors.mock.calls.some(([line]) => String(line).includes('渠道 stop 异常'))).toBe(true);
    });

    it('同步抛错的第三方 stop 不阻断全局停止；后台完成后释放该渠道', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failed = fakeChannel();
        const normal = fakeChannel();
        // JS 插件可能在返回 Promise 前抛错；覆盖 allSettled 的隔离语义，不替换 manager 本体。
        vi.mocked(failed.channel.stop).mockImplementation(() => {
            failed.resolve();
            throw new Error('synchronous plugin stop');
        });
        channelManager.register(failed.channel);
        channelManager.register(normal.channel);
        await channelManager.start(failed.channel.id);
        await channelManager.start(normal.channel.id);
        await channelManager.stopAll();
        await vi.waitFor(() => expect(channelManager.isRunning(failed.channel.id)).toBe(false));
        expect(channelManager.isRunning(normal.channel.id)).toBe(false);
        expect(failed.signal()!.aborted).toBe(true);
        expect(normal.channel.stop).toHaveBeenCalledTimes(1);
        expect(errors.mock.calls.some(([line]) => String(line).includes('停止渠道失败'))).toBe(true);
    });
});
