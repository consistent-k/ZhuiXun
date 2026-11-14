/**
 * 渠道管理器（纯逻辑，零后端依赖）：注册、启停、状态管理。
 * 事件不在此发（走 ChannelRuntime.emitEvent）；宿主持有实例（不导出全局单例，避免 bundle 双份）。
 */
import type { Channel, ChannelLogger } from './types';

interface ChannelState {
    channel: Channel;
    abortController: AbortController | null;
    startedAt: number | null;
}

const noopLogger: ChannelLogger = {
    info: () => {},
    warn: () => {},
    error: () => {}
};

export class ChannelManager {
    private channels = new Map<string, ChannelState>();
    private log: ChannelLogger;

    constructor(logger: ChannelLogger = noopLogger) {
        this.log = logger;
    }

    /** 注册一个 channel（重复注册忽略，便于热重载幂等）。 */
    register(channel: Channel): void {
        if (this.channels.has(channel.id)) {
            this.log.warn('渠道已注册，忽略重复注册', { id: channel.id });
            return;
        }
        this.channels.set(channel.id, { channel, abortController: null, startedAt: null });
        this.log.info('注册渠道', { id: channel.id, name: channel.name });
    }

    get(id: string): Channel | undefined {
        return this.channels.get(id)?.channel;
    }

    list(): Channel[] {
        return Array.from(this.channels.values()).map((s) => s.channel);
    }

    isRunning(id: string): boolean {
        return this.channels.get(id)?.abortController != null;
    }

    getUptime(id: string): number {
        const startedAt = this.channels.get(id)?.startedAt;
        return startedAt ? Date.now() - startedAt : 0;
    }

    /** 启动指定 channel（后台运行 monitor 循环，不阻塞调用方）。 */
    async start(id: string): Promise<void> {
        const state = this.channels.get(id);
        if (!state) throw new Error(`渠道 "${id}" 未注册`);
        if (state.abortController) throw new Error(`渠道 "${id}" 已在运行`);
        if (!state.channel.isConfigured()) throw new Error(`渠道 "${id}" 未配置`);

        const abortController = new AbortController();
        state.abortController = abortController;
        state.startedAt = Date.now();
        state.channel.status = 'running';
        this.log.info('启动渠道', { id });

        void state.channel
            .start({ abortSignal: abortController.signal })
            .catch((err) => {
                state.channel.status = 'error';
                this.log.error('渠道运行异常退出', { id, err });
            })
            .finally(() => {
                state.abortController = null;
                state.startedAt = null;
                if (state.channel.status !== 'error') state.channel.status = 'idle';
                this.log.info('渠道已停止', { id });
            });
    }

    async stop(id: string): Promise<void> {
        const state = this.channels.get(id);
        if (!state) throw new Error(`渠道 "${id}" 未注册`);
        if (!state.abortController) return;
        state.abortController.abort();
        await state.channel.stop().catch((err) => this.log.error('渠道 stop 异常', { id, err }));
        state.abortController = null;
        state.startedAt = null;
        state.channel.status = 'idle';
    }

    /** 停止所有 channel（进程退出兜底）。 */
    async stopAll(): Promise<void> {
        const results = await Promise.allSettled(Array.from(this.channels.keys()).map((id) => this.stop(id)));
        for (const r of results) {
            if (r.status === 'rejected') this.log.error('停止渠道失败', { reason: r.reason });
        }
    }
}
