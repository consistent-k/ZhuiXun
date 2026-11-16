import { App, DatePicker, Form, Input, InputNumber, Select, Space, TimePicker } from 'antd';
import { useId } from 'react';

import Modal from '@/components/Modal';
import type { AutomationKind, AutomationSchedule, AutomationView } from '@/types/automation';
import dayjs from '@/utils/dayjs';

import { validateCron } from '../helpers';

interface AutomationEditModalProps {
    open: boolean;
    /** 编辑态：传入已有任务；新建态为 null */
    editing: AutomationView | null;
    onCancel: () => void;
    /** 提交回调：返回构造好的 title/prompt/schedule/enabled */
    onSubmit: (values: { title: string; prompt: string; schedule: AutomationSchedule; enabled: boolean }) => void;
}

interface FormValues {
    title: string;
    prompt: string;
    kind: AutomationKind;
    afterSeconds?: number;
    at?: ReturnType<typeof dayjs>;
    everyValue?: number;
    everyUnit?: 'second' | 'minute' | 'hour';
    time?: ReturnType<typeof dayjs>;
    weekdays?: number[];
    cronExpr?: string;
    timeZone?: string;
}

const KIND_OPTIONS: { value: AutomationKind; label: string }[] = [
    { value: 'after', label: '延迟后执行一次' },
    { value: 'at', label: '指定时间执行一次' },
    { value: 'every', label: '固定间隔重复' },
    { value: 'daily', label: '每天' },
    { value: 'weekly', label: '每周' },
    { value: 'cron', label: 'cron 表达式' }
];

const WEEKDAY_OPTIONS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, value) => ({
    value,
    label
}));

/** 把 "HH:mm" 解析为今天该时刻的 dayjs（不依赖 customParseFormat 插件） */
function parseHm(hm: string): ReturnType<typeof dayjs> {
    const [h, m] = hm.split(':').map(Number);
    return dayjs()
        .hour(h || 0)
        .minute(m || 0)
        .second(0);
}

/** 把已有 schedule 回填为表单值 */
function scheduleToForm(s: AutomationSchedule): Partial<FormValues> {
    switch (s.kind) {
        case 'after':
            return { kind: 'after', afterSeconds: s.afterSeconds };
        case 'at':
            return { kind: 'at', at: dayjs(s.at) };
        case 'every':
            return { kind: 'every', everyValue: s.everySeconds, everyUnit: 'second' };
        case 'daily':
            return { kind: 'daily', time: parseHm(s.time), timeZone: s.timeZone };
        case 'weekly':
            return { kind: 'weekly', time: parseHm(s.time), weekdays: s.weekdays, timeZone: s.timeZone };
        case 'cron':
            return { kind: 'cron', cronExpr: s.expression, timeZone: s.timeZone };
    }
}

/** 从表单值构造 schedule（已通过校验） */
function formToSchedule(v: FormValues): AutomationSchedule {
    const tz = v.timeZone?.trim() || undefined;
    switch (v.kind) {
        case 'after':
            return { kind: 'after', afterSeconds: v.afterSeconds ?? 0 };
        case 'at':
            return { kind: 'at', at: (v.at ?? dayjs()).valueOf() };
        case 'every': {
            const mul = v.everyUnit === 'hour' ? 3600 : v.everyUnit === 'minute' ? 60 : 1;
            return { kind: 'every', everySeconds: (v.everyValue ?? 1) * mul };
        }
        case 'daily':
            return { kind: 'daily', time: (v.time ?? dayjs()).format('HH:mm'), timeZone: tz };
        case 'weekly':
            return {
                kind: 'weekly',
                time: (v.time ?? dayjs()).format('HH:mm'),
                weekdays: v.weekdays ?? [],
                timeZone: tz
            };
        case 'cron':
            return { kind: 'cron', expression: (v.cronExpr ?? '').trim(), timeZone: tz };
    }
}

export default function AutomationEditModal({ open, editing, onCancel, onSubmit }: AutomationEditModalProps) {
    const formId = useId();

    return (
        <Modal
            title={editing ? '编辑自动化任务' : '新建自动化任务'}
            open={open}
            onCancel={onCancel}
            okButtonProps={{ htmlType: 'submit', form: formId }}
            width={560}
        >
            <AutomationForm id={formId} editing={editing} onSubmit={onSubmit} />
        </Modal>
    );
}

function AutomationForm({
    id,
    editing,
    onSubmit
}: Pick<AutomationEditModalProps, 'editing' | 'onSubmit'> & { id: string }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<FormValues>();
    const kind = Form.useWatch('kind', form);
    // Form 与弹窗内容一起挂载，字段在 StrictMode 重新注册时也能从初始值恢复。
    const initialValues: Partial<FormValues> = editing
        ? { title: editing.title, prompt: editing.prompt, ...scheduleToForm(editing.schedule) }
        : { kind: 'daily', everyUnit: 'minute', everyValue: 30 };

    const handleFinish = (v: FormValues) => {
        if (v.kind === 'cron') {
            const err = validateCron(v.cronExpr ?? '');
            if (err) {
                message.error(err);
                return;
            }
        }
        if (v.kind === 'weekly' && (!v.weekdays || v.weekdays.length === 0)) {
            message.error('请至少选择一个星期');
            return;
        }
        onSubmit({
            title: v.title.trim(),
            prompt: v.prompt.trim(),
            schedule: formToSchedule(v),
            enabled: editing?.enabled ?? true
        });
    };

    return (
        <Form
            id={id}
            form={form}
            layout="vertical"
            preserve={false}
            initialValues={initialValues}
            onFinish={handleFinish}
        >
            <Form.Item name="title" label="任务名称" rules={[{ required: true, message: '请输入任务名称' }]}>
                <Input placeholder="如：每天早晨汇总今日日程" maxLength={120} />
            </Form.Item>
            <Form.Item
                name="prompt"
                label="执行指令（到点回灌给 AI 的 prompt）"
                rules={[{ required: true, message: '请输入执行指令' }]}
            >
                <Input.TextArea rows={4} placeholder="到点时自动发给 AI 的内容" />
            </Form.Item>
            <Form.Item name="kind" label="触发方式" rules={[{ required: true }]}>
                <Select options={KIND_OPTIONS} />
            </Form.Item>

            {kind === 'after' && (
                <Form.Item label="延迟秒数" name="afterSeconds" rules={[{ required: true, message: '请输入延迟秒数' }]}>
                    <InputNumber min={1} />
                </Form.Item>
            )}
            {kind === 'at' && (
                <Form.Item name="at" label="执行时间" rules={[{ required: true, message: '请选择执行时间' }]}>
                    <DatePicker showTime style={{ width: '100%' }} />
                </Form.Item>
            )}
            {kind === 'every' && (
                <Form.Item label="间隔" required>
                    <Space.Compact style={{ width: '100%' }}>
                        <Form.Item name="everyValue" noStyle rules={[{ required: true, message: '请输入间隔' }]}>
                            <InputNumber min={1} style={{ width: '60%' }} />
                        </Form.Item>
                        <Form.Item name="everyUnit" noStyle initialValue="minute">
                            <Select
                                style={{ width: '40%' }}
                                options={[
                                    { value: 'second', label: '秒' },
                                    { value: 'minute', label: '分钟' },
                                    { value: 'hour', label: '小时' }
                                ]}
                            />
                        </Form.Item>
                    </Space.Compact>
                </Form.Item>
            )}
            {(kind === 'daily' || kind === 'weekly') && (
                <Form.Item name="time" label="时间" rules={[{ required: true, message: '请选择时间' }]}>
                    <TimePicker format="HH:mm" style={{ width: '100%' }} />
                </Form.Item>
            )}
            {kind === 'weekly' && (
                <Form.Item name="weekdays" label="星期" rules={[{ required: true, message: '请选择星期' }]}>
                    <Select mode="multiple" options={WEEKDAY_OPTIONS} placeholder="选择每周哪几天" />
                </Form.Item>
            )}
            {kind === 'cron' && (
                <Form.Item
                    name="cronExpr"
                    label="cron 表达式（五段：分 时 日 月 周）"
                    rules={[
                        { required: true, message: '请输入 cron 表达式' },
                        {
                            validator: (_r, value) => {
                                const err = value ? validateCron(value) : null;
                                return err ? Promise.reject(new Error(err)) : Promise.resolve();
                            }
                        }
                    ]}
                >
                    <Input placeholder="如 0 9 * * 1-5（工作日每天 09:00）" />
                </Form.Item>
            )}
            {(kind === 'daily' || kind === 'weekly' || kind === 'cron') && (
                <Form.Item name="timeZone" label="时区（可选，IANA 名，缺省用本机时区）">
                    <Input placeholder="如 Asia/Shanghai" />
                </Form.Item>
            )}
        </Form>
    );
}
