/**
 * 统一用东八区（UTC+8，北京时间）生成日志时间戳与日志文件日期。
 *
 * 背景：此前用 new Date().toISOString() 记录的是 UTC，桌面端在国内运行时日志时间比本地慢 8 小时，
 * 排障对时不便；且日志文件按 UTC 日切，跨零点的归档与人的"当天"不一致。这里固定按 Asia/Shanghai 生成，
 * 不随部署机器时区漂移，返回带 +08:00 偏移的 ISO 串——机器可解析、人可读。
 * 时间处理统一走 dayjs（utc + timezone 插件），不再手写毫秒偏移。
 */
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

/** 日志固定时区：北京时间，不随机器时区漂移 */
const LOG_TZ = 'Asia/Shanghai';

/** 北京时间时间戳，形如 2026-09-20T14:05:23.729+08:00。 */
export function nowTimestamp(date = new Date()): string {
    return dayjs(date).tz(LOG_TZ).format('YYYY-MM-DDTHH:mm:ss.SSSZ');
}

/** 北京时区日期 YYYY-MM-DD，用于日志文件按天切分。 */
export function currentDate(date = new Date()): string {
    return dayjs(date).tz(LOG_TZ).format('YYYY-MM-DD');
}
