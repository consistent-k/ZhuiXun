/**
 * 运行形态判定：收口此前散在 error-handler / logging(levels,file,console) / chat
 * 共 5 处的 `process.env.NODE_ENV === 'production'` 重复判断。调用时求值。
 */
import { optional } from './env';

/** 是否生产环境（NODE_ENV === 'production'）。 */
export function isProd(): boolean {
    return optional('NODE_ENV') === 'production';
}

/** 是否开发/非生产环境。 */
export function isDev(): boolean {
    return !isProd();
}
