import { HistoryOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { Button, Popconfirm, Space, Switch, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import type { AutomationView } from '@/types/automation';
import dayjs from '@/utils/dayjs';

import { describeSchedule, dispatchTag, lifecycleTag } from '../helpers';

interface AutomationTableProps {
    data: AutomationView[];
    loading: boolean;
    onToggle: (row: AutomationView, enabled: boolean) => void;
    onRun: (row: AutomationView) => void;
    onEdit: (row: AutomationView) => void;
    onDelete: (row: AutomationView) => void;
    onHistory: (row: AutomationView) => void;
}

export default function AutomationTable({
    data,
    loading,
    onToggle,
    onRun,
    onEdit,
    onDelete,
    onHistory
}: AutomationTableProps) {
    const columns: ColumnsType<AutomationView> = [
        {
            title: '任务',
            dataIndex: 'title',
            render: (title: string, row) => (
                <div>
                    <div style={{ fontWeight: 600 }}>{title}</div>
                    <div className="automation-sub" title={row.prompt}>
                        {row.prompt.length > 48 ? `${row.prompt.slice(0, 48)}…` : row.prompt}
                    </div>
                    {row.lastError && <div className="automation-last-error">上次失败：{row.lastError}</div>}
                </div>
            )
        },
        {
            title: '触发规则',
            dataIndex: 'schedule',
            width: 160,
            render: (_: unknown, row) => describeSchedule(row.schedule)
        },
        {
            title: '状态',
            width: 140,
            render: (_: unknown, row) => {
                const life = lifecycleTag(row.lifecycleStatus);
                const dispatch = dispatchTag(row.dispatchStatus);
                return (
                    <Space size={4} wrap>
                        <Tag color={life.color}>{life.text}</Tag>
                        {dispatch && <Tag color={dispatch.color}>{dispatch.text}</Tag>}
                    </Space>
                );
            }
        },
        {
            title: '下次运行',
            dataIndex: 'nextRunAt',
            width: 170,
            render: (ts?: number) => (ts ? dayjs(ts).format('YYYY-MM-DD HH:mm') : '-')
        },
        {
            title: '启用',
            dataIndex: 'enabled',
            width: 70,
            render: (enabled: boolean, row) => <Switch checked={enabled} onChange={(next) => onToggle(row, next)} />
        },
        {
            title: '操作',
            width: 180,
            render: (_: unknown, row) => (
                <Space size={4}>
                    <Tooltip title="立即运行一次">
                        <Button type="text" size="small" icon={<PlayCircleOutlined />} onClick={() => onRun(row)} />
                    </Tooltip>
                    <Tooltip title="运行历史">
                        <Button type="text" size="small" icon={<HistoryOutlined />} onClick={() => onHistory(row)} />
                    </Tooltip>
                    <Button type="link" size="small" onClick={() => onEdit(row)}>
                        编辑
                    </Button>
                    <Popconfirm
                        title="删除任务"
                        description="删除后该任务及其调度将被移除，不可撤销。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => onDelete(row)}
                    >
                        <Button type="link" size="small" danger>
                            删除
                        </Button>
                    </Popconfirm>
                </Space>
            )
        }
    ];

    return (
        <Table<AutomationView>
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={data}
            pagination={false}
            size="middle"
        />
    );
}
