/**
 * 对象 id 校验的唯一实现。
 *
 * 会话 id 会拼进文件名，必须杜绝路径穿越；项目/任务 id 同一约定。
 * 改造前这段正则在 3 个 store 里各写一份，新增模块容易漏校验，收口于此。
 */

/** 仅允许安全字符：字母、数字、下划线、连字符，长度 1~128。 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidId(id: unknown): id is string {
    return typeof id === 'string' && SAFE_ID.test(id);
}

/** 非法 id 直接抛错，供「绝不接受外部 id」的写路径使用。 */
export function assertValidId(id: unknown, what = 'id'): asserts id is string {
    if (!isValidId(id)) throw new Error(`非法${what}`);
}
