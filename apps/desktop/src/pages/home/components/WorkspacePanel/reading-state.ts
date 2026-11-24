interface ReadingPosition {
    scroll?: number;
    page?: number;
    scale?: number;
}
const positions = new Map<string, ReadingPosition>();
/** 只缓存轻量阅读位置；重启不恢复，不保存正文或 DOM。 */
export function readingPosition(key: string): ReadingPosition {
    return positions.get(key) ?? {};
}
/** 最多保留 100 个资源的阅读位置。 */
export function rememberPosition(key: string, update: ReadingPosition) {
    const previous = positions.get(key);
    positions.delete(key);
    positions.set(key, { ...previous, ...update });
    if (positions.size > 100) positions.delete(positions.keys().next().value!);
}
