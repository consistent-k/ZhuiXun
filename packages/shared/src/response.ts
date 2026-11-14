/** 后端统一响应信封：业务码 + 可选数据 + 可选错误信息。前后端唯一契约。 */
export interface ApiResponse<T = unknown> {
    /** 业务码，成功为 0 */
    code: number;
    /** 业务数据 */
    data?: T;
    /** 错误信息 */
    message?: string;
}
