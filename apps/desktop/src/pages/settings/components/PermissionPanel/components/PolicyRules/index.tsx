import { DeleteOutlined, ExperimentOutlined, PlusOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Empty, Form, Input, Popconfirm, Select, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';

import { Modal } from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { evaluatePolicyApi, fetchPolicyRulesApi, updatePolicyRulesApi } from '@/services';
import type { PermissionRuleSet, PolicyRulesView } from '@/types/permission';

import { RuleEvaluateModal } from '../RuleEvaluateModal';

import useStyles from './styles';

type RuleKind = keyof PermissionRuleSet;

interface RuleRow {
    key: string;
    kind: RuleKind;
    rule: string;
    builtin: boolean;
}

const KIND_META: Record<RuleKind, { label: string; color: string; hint: string }> = {
    deny: { label: '拒绝', color: 'red', hint: '直接拒绝执行，模型会收到拒绝原因（危险模式下仍生效）' },
    ask: { label: '需确认', color: 'orange', hint: '每次弹出确认卡，覆盖「已记住」与信任项目的自动放行' },
    allow: { label: '免确认', color: 'green', hint: '自动放行；写入系统目录仍需确认' }
};

const KINDS: RuleKind[] = ['deny', 'ask', 'allow'];

const BASELINE_SOURCE_LABEL: Record<PolicyRulesView['baselineSource'], string> = {
    builtin: '内置',
    external: '外部',
    invalid: '外部（已损坏）'
};

const SYNTAX_EXAMPLES = [
    'Bash(git push:*) —— 命令头前缀，复合命令逐段匹配',
    'Read(**/.env) / Write(./dist/**) —— 路径 glob，~/ 为家目录，./ 为项目主目录',
    'WebFetch(domain:*.example.com) —— 按域名',
    'MCP(github_*) —— 按 MCP 运行时工具名',
    'create_skill —— 其它工具按名称精确匹配'
];

interface RuleFormValues {
    kind: RuleKind;
    rule: string;
}

/** 「策略规则」：团队基线只读展示，用户规则可增删；试算入口排查「为什么被拦」。 */
export function PolicyRules() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [form] = Form.useForm<RuleFormValues>();
    const watchedKind = Form.useWatch('kind', form) ?? 'ask';
    const [adding, setAdding] = useState(false);
    const [saving, setSaving] = useState(false);
    const [evaluating, setEvaluating] = useState(false);

    const { data, loading, mutate } = useRequest(async () => {
        const res = await fetchPolicyRulesApi();
        return res.code === SUCCESS_CODE ? res.data : undefined;
    });

    const rows = useMemo<RuleRow[]>(() => {
        if (!data) return [];
        const list: RuleRow[] = [];
        for (const kind of KINDS) {
            data.baseline[kind].forEach((rule, i) => list.push({ key: `b-${kind}-${i}`, kind, rule, builtin: true }));
            data.user[kind].forEach((rule, i) => list.push({ key: `u-${kind}-${i}`, kind, rule, builtin: false }));
        }
        return list;
    }, [data]);

    const save = async (next: PermissionRuleSet, successText: string): Promise<boolean> => {
        setSaving(true);
        try {
            const res = await updatePolicyRulesApi(next);
            if (res.code !== SUCCESS_CODE || !res.data) return false;
            mutate(res.data);
            message.success(successText);
            return true;
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = (row: RuleRow) => {
        if (!data) return;
        const next = { ...data.user, [row.kind]: data.user[row.kind].filter((r) => r !== row.rule) };
        void save(next, '已删除规则，下一次工具调用生效');
    };

    const handleAdd = async () => {
        if (!data) return;
        let values: RuleFormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        const rule = values.rule.trim();
        if (data.user[values.kind].includes(rule)) {
            message.info('该规则已存在');
            return;
        }
        const next = { ...data.user, [values.kind]: [...data.user[values.kind], rule] };
        if (await save(next, '已添加规则，下一次工具调用生效')) {
            setAdding(false);
            form.resetFields();
        }
    };

    // 提交前先经后端校验语法，给出与落盘一致的错误文案
    const validateRule = async (_: unknown, value?: string) => {
        if (!value?.trim()) throw new Error('请输入规则');
        const res = await evaluatePolicyApi({ rule: value.trim() });
        if (res.code === SUCCESS_CODE && res.data && !res.data.valid) throw new Error(res.data.error ?? '规则不合法');
    };

    const columns: ColumnsType<RuleRow> = [
        {
            title: '类型',
            dataIndex: 'kind',
            width: 96,
            render: (kind: RuleKind) => <Tag color={KIND_META[kind].color}>{KIND_META[kind].label}</Tag>
        },
        {
            title: '规则',
            dataIndex: 'rule',
            render: (rule: string) => <code className="policy-rules-code">{rule}</code>
        },
        {
            title: '来源',
            dataIndex: 'builtin',
            width: 140,
            render: (builtin: boolean) =>
                builtin ? (
                    <Tag>团队基线（{data ? BASELINE_SOURCE_LABEL[data.baselineSource] : ''}）</Tag>
                ) : (
                    <Tag color="blue">用户规则</Tag>
                )
        },
        {
            title: '操作',
            key: 'action',
            width: 88,
            render: (_: unknown, row) =>
                row.builtin ? (
                    <span className="policy-rules-readonly">只读</span>
                ) : (
                    <Popconfirm
                        title="删除此规则？"
                        onConfirm={() => handleDelete(row)}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                    >
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除规则" />
                    </Popconfirm>
                )
        }
    ];

    return (
        <Spin spinning={loading} className={cx('policy-rules', styles.toString())}>
            <div className="policy-rules-hint">
                判定顺序：拒绝 → 需确认 → 免确认 → 原有审批（已记住的授权、信任项目）。团队基线与用户规则合并生效。
            </div>
            {data?.baselineSource === 'invalid' && (
                <Alert
                    className="policy-rules-alert"
                    type="error"
                    showIcon
                    title="团队权限基线文件损坏，所有工具调用均需确认"
                    description={`${data.baselineError ?? ''}（${data.baselinePath}）`}
                />
            )}
            {data && data.invalid.length > 0 && (
                <Alert
                    className="policy-rules-alert"
                    type="warning"
                    showIcon
                    title="以下规则格式不合法，已跳过"
                    description={data.invalid.join('；')}
                />
            )}
            <div className="policy-rules-toolbar">
                <span className="policy-rules-hint">外部基线路径：{data?.baselinePath ?? '-'}</span>
                <div className="policy-rules-actions">
                    <Button icon={<ExperimentOutlined />} onClick={() => setEvaluating(true)}>
                        试算
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)} disabled={!data}>
                        新增规则
                    </Button>
                </div>
            </div>
            <Table
                size="small"
                rowKey="key"
                columns={columns}
                dataSource={rows}
                pagination={false}
                locale={{ emptyText: <Empty description="暂无规则" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />

            <Modal
                className={cx('policy-rules-modal', styles.toString())}
                title="新增策略规则"
                open={adding}
                confirmLoading={saving}
                onOk={handleAdd}
                onCancel={() => setAdding(false)}
            >
                <Form form={form} layout="vertical" initialValues={{ kind: 'ask' }}>
                    <Form.Item name="kind" label="类型" extra={KIND_META[watchedKind].hint}>
                        <Select options={KINDS.map((k) => ({ value: k, label: KIND_META[k].label }))} />
                    </Form.Item>
                    <Form.Item
                        name="rule"
                        label="规则"
                        validateTrigger="onBlur"
                        rules={[{ validator: validateRule }]}
                        extra={
                            <ul className="policy-rules-examples">
                                {SYNTAX_EXAMPLES.map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                        }
                    >
                        <Input placeholder="如 Bash(git push:*)" autoComplete="off" />
                    </Form.Item>
                </Form>
            </Modal>

            <RuleEvaluateModal open={evaluating} onClose={() => setEvaluating(false)} />
        </Spin>
    );
}

export default PolicyRules;
