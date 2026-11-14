import { createLogger } from '@/platform/logging/index';

import { canTransition, createTurnState, type TurnPhase, type TurnState } from './turn-state';

const log = createLogger('TurnMachine');

/**
 * 轮次状态机：只负责状态与合法迁移，不依赖 Hono、不直接做 IO。
 * 非法迁移抛出错误——宁可让 bug 在开发期暴露，也不要静默进入不一致状态。
 */
export class TurnMachine {
    private current: TurnState = createTurnState();

    get state(): Readonly<TurnState> {
        return this.current;
    }

    get phase(): TurnPhase {
        return this.current.phase;
    }

    /** 绑定会话 id 并进入起始阶段。 */
    start(chatId: string): TurnState {
        this.current = { ...this.current, chatId };
        return this.to('starting');
    }

    to(next: TurnPhase, error?: string): TurnState {
        const from = this.current.phase;
        if (!canTransition(from, next)) {
            throw new Error(`非法轮次迁移：${from} → ${next}`);
        }
        this.current = { ...this.current, phase: next, error: error ?? this.current.error };
        log.debug('轮次状态迁移', { from, to: next, chatId: this.current.chatId });
        return this.current;
    }

    /** 任意阶段失败：已在终态时幂等返回。 */
    fail(error: unknown): TurnState {
        if (this.current.phase === 'failed' || this.current.phase === 'completed') return this.current;
        return this.to('failed', error instanceof Error ? error.message : String(error));
    }

    /** 客户端断开。 */
    abort(): TurnState {
        if (this.current.phase === 'aborted' || this.current.phase === 'completed') return this.current;
        return this.to('aborted');
    }
}
