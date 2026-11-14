import { Alert, Button, Checkbox, Form, Input, Select, Tag } from 'antd';
import { useState } from 'react';

import { Modal } from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { evaluatePolicyApi } from '@/services';
import type { PolicyDecision } from '@/types/permission';

import useStyles from './styles';

interface RuleEvaluateModalProps {
    open: boolean;
    onClose: () => void;
}

/** 试算对象的入参字段：与各工具真实 schema 一致（Write/Read 用 path，Edit 用 file_path）。 */
const TOOL_FIELD: Record<string, { key: string; label: string; placeholder: string }> = {
    Bash: { key: 'command', label: '命令', placeholder: 'git push --force origin main' },
    Read: { key: 'path', label: '路径', placeholder: '~/.ssh/id_rsa 或 .env' },
    Write: { key: 'path', label: '路径', placeholder: './dist/app.js' },
    Edit: { key: 'file_path', label: '路径', placeholder: 'src/index.ts' },
    Grep: { key: 'path', label: '检索路径', placeholder: '~/.aws' },
    LS: { key: 'path', label: '目录', placeholder: '~/.ssh' },
    WebFetch: { key: 'url', label: 'URL', placeholder: 'https://docs.example.com/guide' }
};

const DECISION_META: Record<
    PolicyDecision['decision'],
    { label: string; type: 'error' | 'warning' | 'success' | 'info' }
> = {
    deny: { label: '拒绝', type: 'error' },
    ask: { label: '需确认', type: 'warning' },
    allow: { label: '免确认', type: 'success' },
    none: { label: '未命中规则（走原有审批）', type: 'info' }
};

const SOURCE_LABEL: Record<NonNullable<PolicyDecision['source']>, string> = {
    baseline: '团队基线',
    user: '用户规则',
    floor: '应用底线'
};

interface EvaluateFormValues {
    toolName: string;
    value?: string;
    cwd?: string;
    mcp?: boolean;
}

/** 规则试算：选工具 + 填参数，按当前策略给出判定与命中规则，只判定不执行。 */
export function RuleEvaluateModal({ open, onClose }: RuleEvaluateModalProps) {
    const { styles, cx } = useStyles();
    const [form] = Form.useForm<EvaluateFormValues>();
    const toolName = Form.useWatch('toolName', form) ?? 'Bash';
    const [result, setResult] = useState<PolicyDecision | null>(null);
    const [running, setRunning] = useState(false);
    const field = TOOL_FIELD[toolName];

    const handleRun = async () => {
        const values = await form.validateFields().catch(() => null);
        if (!values) return;
        const name = values.toolName.trim();
        const fieldKey = TOOL_FIELD[name]?.key;
        setRunning(true);
        try {
            const res = await evaluatePolicyApi({
                toolName: name,
                input: fieldKey && values.value ? { [fieldKey]: values.value } : {},
                cwd: values.cwd?.trim() || undefined,
                mcp: values.mcp
            });
            if (res.code === SUCCESS_CODE && res.data?.decision) setResult(res.data.decision);
        } finally {
            setRunning(false);
        }
    };

    const meta = result ? DECISION_META[result.decision] : undefined;

    return (
        <Modal
            className={cx('rule-evaluate-modal', styles.toString())}
            title="规则试算"
            open={open}
            onCancel={onClose}
            afterClose={() => {
                setResult(null);
                form.resetFields();
            }}
            footer={[
                <Button key="close" onClick={onClose}>
                    关闭
                </Button>,
                <Button key="run" type="primary" loading={running} onClick={handleRun}>
                    试算
                </Button>
            ]}
        >
            <Form form={form} layout="vertical" initialValues={{ toolName: 'Bash' }}>
                <Form.Item
                    name="toolName"
                    label="工具"
                    rules={[{ required: true, whitespace: true, message: '请选择或输入工具名' }]}
                >
                    <Select
                        showSearch
                        options={[...Object.keys(TOOL_FIELD), 'create_skill', 'update_skill'].map((name) => ({
                            value: name,
                            label: name
                        }))}
                    />
                </Form.Item>
                {field ? (
                    <Form.Item name="value" label={field.label}>
                        <Input placeholder={field.placeholder} autoComplete="off" />
                    </Form.Item>
                ) : null}
                <Form.Item
                    name="cwd"
                    label="工作目录（可选）"
                    extra="相对路径与 ./ 规则按它解析，缺省为无项目对话的临时工作区"
                >
                    <Input placeholder="/Users/me/project" autoComplete="off" />
                </Form.Item>
                <Form.Item name="mcp" valuePropName="checked">
                    <Checkbox>按 MCP 工具判定（用于 MCP(...) 规则）</Checkbox>
                </Form.Item>
            </Form>
            {result && meta && (
                <Alert
                    type={meta.type}
                    showIcon
                    title={meta.label}
                    description={
                        result.decision === 'none' ? (
                            '没有命中任何策略规则；实际执行时按「已记住的授权」、信任项目与默认审批处理。'
                        ) : (
                            <div className="rule-evaluate-modal-detail">
                                <div>
                                    命中：<code>{result.rule}</code>
                                    {result.source && (
                                        <Tag className="rule-evaluate-modal-tag">{SOURCE_LABEL[result.source]}</Tag>
                                    )}
                                </div>
                                {result.reason && <div>{result.reason}</div>}
                            </div>
                        )
                    }
                />
            )}
        </Modal>
    );
}

export default RuleEvaluateModal;
