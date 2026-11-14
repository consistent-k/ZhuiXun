/** 任务状态机：待办 → 进行中 → 完成。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** 单个任务。blocks/blockedBy 互为反向边，由后端 store 维护一致。 */
export interface Task {
    /** 服务端生成的会话内自增 id（"1","2"…），模型只引用不自造 */
    id: string;
    /** 祈使句标题 */
    subject: string;
    /** 可选详情 */
    description?: string;
    /** 进行时描述，in_progress 时前端展示 */
    activeForm?: string;
    status: TaskStatus;
    /** 本任务阻塞的下游任务 id（下游的 blockedBy 含本任务） */
    blocks: string[];
    /** 阻塞本任务的上游任务 id（需全部 completed 才可置 in_progress） */
    blockedBy: string[];
}
