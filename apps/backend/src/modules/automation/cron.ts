/**
 * 自动化任务触发时间计算（纯函数，无副作用、无 I/O）。
 *
 * 设计取舍：
 * - 相对时间（after/every）一律用传入的 `from`（真实 Date.now()）锚定，不信任模型换算的绝对时间。
 * - daily/weekly/cron 按**服务器本地时区**计算；`timeZone` 字段 P0 预留不生效（单用户桌面场景本地时区即预期）。
 * - cron 为五段 Vixie 方言（分 时 日 月 周），最小粒度 1 分钟；日(dom)与周(dow)都受限时按「任一匹配」。
 */
import type { AutomationSchedule } from '@zhuixun/shared';

/** 一次性触发（after/at）跑完即终态；其余为周期。 */
export function isOneShot(kind: AutomationSchedule['kind']): boolean {
    return kind === 'after' || kind === 'at';
}

/** 解析 "HH:mm"；非法抛错。 */
function parseTimeOfDay(time: string): { h: number; m: number } {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (!match) throw new Error(`时间格式应为 HH:mm，收到 "${time}"`);
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error(`时间越界：${time}`);
    return { h, m };
}

/** 单个 cron 字段解析为「允许值集合」。支持 * / a / a-b / a,b / *\/n / a-b/n。 */
function parseCronField(field: string, min: number, max: number): Set<number> {
    const allowed = new Set<number>();
    for (const part of field.split(',')) {
        const [rangePart, stepPart] = part.split('/');
        const step = stepPart === undefined ? 1 : Number(stepPart);
        if (!Number.isInteger(step) || step <= 0) throw new Error(`cron 步长非法：${part}`);
        let lo: number;
        let hi: number;
        if (rangePart === '*') {
            lo = min;
            hi = max;
        } else if (rangePart.includes('-')) {
            const [a, b] = rangePart.split('-').map(Number);
            lo = a;
            hi = b;
        } else {
            lo = Number(rangePart);
            hi = lo;
        }
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
            throw new Error(`cron 字段越界：${part}（应在 ${min}-${max}）`);
        }
        for (let v = lo; v <= hi; v += step) allowed.add(v);
    }
    return allowed;
}

// PLACEHOLDER_CRON

interface CronFields {
    minute: Set<number>;
    hour: Set<number>;
    dom: Set<number>;
    month: Set<number>;
    dow: Set<number>;
    /** dom 与 dow 是否都被限定（决定「任一匹配」语义）。 */
    domRestricted: boolean;
    dowRestricted: boolean;
}

/** 解析五段 cron；非法抛错。dow 7 归一到 0（周日）。 */
export function parseCron(expression: string): CronFields {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) throw new Error(`cron 需 5 段（分 时 日 月 周），收到 ${fields.length} 段`);
    const [min, hr, dom, mon, dowRaw] = fields;
    const dowField = dowRaw.replace(/7/g, '0');
    return {
        minute: parseCronField(min, 0, 59),
        hour: parseCronField(hr, 0, 23),
        dom: parseCronField(dom, 1, 31),
        month: parseCronField(mon, 1, 12),
        dow: parseCronField(dowField, 0, 6),
        domRestricted: dom !== '*',
        dowRestricted: dowField !== '*'
    };
}

/** 某时刻是否命中 cron（按本地时区取各分量）。 */
function cronMatches(f: CronFields, date: Date): boolean {
    if (!f.minute.has(date.getMinutes())) return false;
    if (!f.hour.has(date.getHours())) return false;
    if (!f.month.has(date.getMonth() + 1)) return false;
    const domOk = f.dom.has(date.getDate());
    const dowOk = f.dow.has(date.getDay());
    // 标准 cron：dom 与 dow 都受限时任一命中即可；否则取受限的那个（都不限则恒真）。
    if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
    if (f.domRestricted) return domOk;
    if (f.dowRestricted) return dowOk;
    return true;
}

/** 从 from 之后找下一个命中的分钟（本地时区）；366 天内无命中返回 undefined（防死循环）。 */
export function nextCronAt(expression: string, from: number): number | undefined {
    const f = parseCron(expression);
    // 对齐到下一整分钟起步。
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    const limit = from + 366 * 24 * 60 * 60 * 1000;
    while (d.getTime() <= limit) {
        if (cronMatches(f, d)) return d.getTime();
        d.setMinutes(d.getMinutes() + 1);
    }
    return undefined;
}

/** 下一个命中「本地 h:m，且星期在 weekdays 内（空=每天）」且严格晚于 from 的时刻。 */
function nextWallClock(from: number, h: number, m: number, weekdays?: number[]): number {
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setHours(h, m);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    if (!weekdays || weekdays.length === 0) return d.getTime();
    const set = new Set(weekdays);
    for (let i = 0; i < 8; i++) {
        if (set.has(d.getDay()) && d.getTime() > from) return d.getTime();
        d.setDate(d.getDate() + 1);
        d.setHours(h, m, 0, 0);
    }
    // 理论不可达（一周内必有命中）；兜底返回首个候选。
    return d.getTime();
}

/**
 * 计算下次触发时间（epoch ms）。周期任务返回下一次；一次性（after/at）返回其唯一触发点。
 * 无法计算（如 cron 366 天内无命中）返回 undefined，调用方应判为非法/终态。
 */
export function computeNextRunAt(schedule: AutomationSchedule, from: number = Date.now()): number | undefined {
    switch (schedule.kind) {
        case 'after':
            return from + schedule.afterSeconds * 1000;
        case 'at':
            return schedule.at;
        case 'every':
            return from + schedule.everySeconds * 1000;
        case 'daily': {
            const { h, m } = parseTimeOfDay(schedule.time);
            return nextWallClock(from, h, m);
        }
        case 'weekly': {
            const { h, m } = parseTimeOfDay(schedule.time);
            return nextWallClock(from, h, m, schedule.weekdays);
        }
        case 'cron':
            return nextCronAt(schedule.expression, from);
    }
}

/** 校验触发规则是否可被调度（创建/编辑前置校验，非法抛错）。 */
export function validateSchedule(schedule: AutomationSchedule): void {
    switch (schedule.kind) {
        case 'after':
            if (!(schedule.afterSeconds > 0)) throw new Error('afterSeconds 需为正数');
            break;
        case 'at':
            if (!(schedule.at > 0)) throw new Error('at 需为有效 epoch 毫秒');
            break;
        case 'every':
            if (!(schedule.everySeconds >= 60)) throw new Error('everySeconds 最小 60 秒');
            break;
        case 'daily':
            parseTimeOfDay(schedule.time);
            break;
        case 'weekly':
            parseTimeOfDay(schedule.time);
            if (!schedule.weekdays?.every((d) => d >= 0 && d <= 6)) throw new Error('weekdays 需在 0-6');
            break;
        case 'cron':
            parseCron(schedule.expression);
            break;
    }
}
