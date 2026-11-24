const requests = new Map<string, number>();
/** 显式打开和收起共享序号；晚到的解析结果不能覆盖用户后续操作。 */
export function beginFileOpen(id: string) {
    const revision = (requests.get(id) ?? 0) + 1;
    requests.set(id, revision);
    return revision;
}
/** 只有最新一次用户操作仍有权激活标签。 */
export function isCurrentFileOpen(id: string, revision: number) {
    return requests.get(id) === revision;
}
