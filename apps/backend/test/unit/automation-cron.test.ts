import { describe, expect, it } from 'vitest';

import { computeNextRunAt, isOneShot, nextCronAt, parseCron, validateSchedule } from '@/modules/automation/cron';

describe('automation cron', () => {
    const from = new Date('2026-01-01T10:00:30').getTime();

    it('after/every 按 from 锚定相对时间', () => {
        expect(computeNextRunAt({ kind: 'after', afterSeconds: 300 }, from)).toBe(from + 300_000);
        expect(computeNextRunAt({ kind: 'every', everySeconds: 600 }, from)).toBe(from + 600_000);
    });

    it('at 原样返回绝对时间', () => {
        expect(computeNextRunAt({ kind: 'at', at: from + 1 }, from)).toBe(from + 1);
    });

    it('isOneShot 仅对 after/at 为真', () => {
        expect(isOneShot('after')).toBe(true);
        expect(isOneShot('at')).toBe(true);
        expect(isOneShot('every')).toBe(false);
        expect(isOneShot('cron')).toBe(false);
    });

    it('daily 下次触发严格晚于 from 且在 24h 内', () => {
        const next = computeNextRunAt({ kind: 'daily', time: '09:30' }, from)!;
        expect(next).toBeGreaterThan(from);
        expect(next - from).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
        const d = new Date(next);
        expect(d.getHours()).toBe(9);
        expect(d.getMinutes()).toBe(30);
    });

    it('weekly 命中指定星期且在 7 天内', () => {
        const next = computeNextRunAt({ kind: 'weekly', time: '08:00', weekdays: [1, 3, 5] }, from)!;
        expect(next).toBeGreaterThan(from);
        expect(next - from).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
        expect([1, 3, 5]).toContain(new Date(next).getDay());
    });

    it('cron */15 下次为 15 分钟内的整 15 分刻度', () => {
        const next = nextCronAt('*/15 * * * *', from)!;
        expect(next).toBeGreaterThan(from);
        expect(next - from).toBeLessThanOrEqual(15 * 60 * 1000);
        const d = new Date(next);
        expect(d.getMinutes() % 15).toBe(0);
        expect(d.getSeconds()).toBe(0);
    });

    it('parseCron 拒绝非法表达式', () => {
        expect(() => parseCron('* * *')).toThrow();
        expect(() => parseCron('60 * * * *')).toThrow();
        expect(() => parseCron('* 24 * * *')).toThrow();
    });

    it('validateSchedule 校验边界', () => {
        expect(() => validateSchedule({ kind: 'every', everySeconds: 30 })).toThrow();
        expect(() => validateSchedule({ kind: 'after', afterSeconds: 0 })).toThrow();
        expect(() => validateSchedule({ kind: 'daily', time: '25:00' })).toThrow();
        expect(() => validateSchedule({ kind: 'weekly', time: '08:00', weekdays: [9] })).toThrow();
        expect(() => validateSchedule({ kind: 'cron', expression: 'bad' })).toThrow();
        // 合法不抛
        expect(() => validateSchedule({ kind: 'every', everySeconds: 60 })).not.toThrow();
    });
});
