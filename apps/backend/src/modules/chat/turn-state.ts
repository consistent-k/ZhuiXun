/**
 * 一轮对话的状态定义与合法转移表。
 *
 * 这里只建模「请求生命周期」，不重写 AI SDK 的工具循环（`createAgentUIStream` 保持不变）。
 * 目的：把原来散在路由里、靠顺序执行的副作用（落库、压缩、标题、记忆维护）显式化，
 * 让顺序可断言、可测试。
 */

export type TurnPhase =
    | 'preparing' // 校验、模型、项目/工作区解析
    | 'starting' // 落 user 消息、启动标题生成
    | 'compacting' // 需要时摘要历史
    | 'streaming' // 模型流 + SSE 旁路录制
    | 'finalizing' // 落 assistant 消息
    | 'completed'
    | 'failed'
    | 'aborted';

export interface TurnState {
    phase: TurnPhase;
    chatId?: string;
    error?: string;
}

/** 正常前进路径 + 任意阶段可失败/中止。 */
const TRANSITIONS: Record<TurnPhase, readonly TurnPhase[]> = {
    preparing: ['starting', 'failed', 'aborted'],
    starting: ['compacting', 'failed', 'aborted'],
    compacting: ['streaming', 'failed', 'aborted'],
    streaming: ['finalizing', 'failed', 'aborted'],
    // 流中途出错时也要落库，因此允许 streaming → finalizing 之外，failed 也可直接 finalize
    finalizing: ['completed', 'failed', 'aborted'],
    completed: [],
    failed: [],
    aborted: []
};

export function canTransition(from: TurnPhase, to: TurnPhase): boolean {
    return TRANSITIONS[from].includes(to);
}

export function createTurnState(): TurnState {
    return { phase: 'preparing' };
}
