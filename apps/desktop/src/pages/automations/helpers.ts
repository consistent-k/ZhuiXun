import type {
    AutomationDispatchStatus,
    AutomationLifecycleStatus,
    AutomationRunOutcome,
    AutomationSchedule
} from '@/types/automation';

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 把触发规则渲染成人类可读文案（列表「触发规则」列用） */
export function describeSchedule(schedule: AutomationSchedule): string {
    switch (schedule.kind) {
        case 'after':
            return `${schedule.afterSeconds} 秒后（一次性）`;
        case 'at':
            return '指定时间（一次性）';
        case 'every': {
            const s = schedule.everySeconds;
            if (s % 3600 === 0) return `每 ${s / 3600} 小时`;
            if (s % 60 === 0) return `每 ${s / 60} 分钟`;
            return `每 ${s} 秒`;
        }
        case 'daily':
            return `每天 ${schedule.time}`;
        case 'weekly': {
            const days = [...schedule.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d] ?? `周${d}`);
            return `每${days.join('、')} ${schedule.time}`;
        }
        case 'cron':
            return `cron: ${schedule.expression}`;
        default:
            return '未知规则';
    }
}

/** 单段 cron 字段是否合法：支持 *、a、a-b、a,b、步进 */ // 分 0-59 / 时 0-23 / 日 1-31 / 月 1-12 / 周 0-6
function isCronFieldValid(field: string, min: number, max: number): boolean {
    if (field === '*') return true;
    return field.split(',').every((part) => {
        const [range, stepRaw] = part.split('/');
        if (stepRaw !== undefined) {
            const step = Number(stepRaw);
            if (!Number.isInteger(step) || step <= 0) return false;
        }
        if (range === '*') return true;
        const [a, b] = range.split('-');
        const start = Number(a);
        if (!Number.isInteger(start) || start < min || start > max) return false;
        if (b === undefined) return true;
        const end = Number(b);
        return Number.isInteger(end) && end >= start && end <= max;
    });
}

/** 前端本地校验五段 cron（分 时 日 月 周）。合法返回 null，非法返回提示文案。 */
export function validateCron(expr: string): string | null {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return 'cron 需为五段：分 时 日 月 周（空格分隔）';
    const bounds: [number, number][] = [
        [0, 59],
        [0, 23],
        [1, 31],
        [1, 12],
        [0, 6]
    ];
    for (let i = 0; i < 5; i++) {
        if (!isCronFieldValid(fields[i], bounds[i][0], bounds[i][1])) {
            return `第 ${i + 1} 段「${fields[i]}」不合法`;
        }
    }
    return null;
}

/** 生命周期状态 → antd Tag 颜色 + 文案 */
export function lifecycleTag(status: AutomationLifecycleStatus): { color: string; text: string } {
    switch (status) {
        case 'active':
            return { color: 'blue', text: '生效中' };
        case 'completed':
            return { color: 'default', text: '已完成' };
        case 'failed':
            return { color: 'error', text: '失败' };
        case 'paused':
            return { color: 'warning', text: '已暂停' };
    }
}

/** 派发状态 → antd Tag 颜色 + 文案（idle 不展示，返回 null） */
export function dispatchTag(status: AutomationDispatchStatus): { color: string; text: string } | null {
    switch (status) {
        case 'idle':
            return null;
        case 'claimed':
            return { color: 'processing', text: '待执行' };
        case 'running':
            return { color: 'processing', text: '执行中' };
        case 'failed':
            return { color: 'error', text: '派发失败' };
    }
}

/** 运行结果 → antd Tag 颜色 + 文案 */
export function outcomeTag(outcome: AutomationRunOutcome): { color: string; text: string } {
    switch (outcome) {
        case 'running':
            return { color: 'processing', text: '执行中' };
        case 'succeeded':
            return { color: 'success', text: '成功' };
        case 'failed':
            return { color: 'error', text: '失败' };
        case 'stopped':
            return { color: 'default', text: '已中止' };
    }
}
