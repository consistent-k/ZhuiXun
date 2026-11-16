import { Drawer, Empty, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchAutomationRunsApi, subscribeAutomationEvents } from '@/services';
import type { AutomationRunView, AutomationView } from '@/types/automation';
import dayjs from '@/utils/dayjs';

import { outcomeTag } from '../helpers';

interface RunHistoryDrawerProps {
    /** 目标任务；为 null 时抽屉关闭 */
    automation: AutomationView | null;
    onClose: () => void;
}

const PAGE_SIZE = 10;

/** 两个 epoch ms 的耗时文案 */
function duration(start?: number, end?: number): string {
    if (!start || !end) return '-';
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export default function RunHistoryDrawer({ automation, onClose }: RunHistoryDrawerProps) {
    const [runs, setRuns] = useState<AutomationRunView[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    // 已完成拉取的 key；loading 由「当前 key 是否已拉取」派生，避免在 effect 里同步 setState（级联渲染）。
    const [loadedKey, setLoadedKey] = useState('');

    // 任务切换时回到第一页：渲染期调整 state（React 推荐写法），不放进 effect。
    const [trackedId, setTrackedId] = useState(automation?.id);
    if (automation?.id !== trackedId) {
        setTrackedId(automation?.id);
        setPage(1);
    }

    const fetchKey = automation ? `${automation.id}:${page}` : '';
    const loading = fetchKey !== '' && fetchKey !== loadedKey;

    // 抽屉自身的台账只按 [automation, page] 拉取，不随列表 store 刷新；订阅 SSE 在本任务有
    // dispatch/settle/changed 事件时自增 refreshTick 触发重拉，避免跑完后仍停在「执行中」。
    const [refreshTick, setRefreshTick] = useState(0);
    useEffect(() => {
        if (!automation) return;
        const id = automation.id;
        return subscribeAutomationEvents((event) => {
            if (event.automationId === id) setRefreshTick((n) => n + 1);
        });
    }, [automation]);

    useEffect(() => {
        if (!automation) return;
        let ignore = false;
        void fetchAutomationRunsApi(automation.id, { page, pageSize: PAGE_SIZE })
            .then((res) => {
                if (ignore) return;
                if (res.code === SUCCESS_CODE && res.data) {
                    setRuns(res.data.runs);
                    setTotal(res.data.total);
                }
            })
            .finally(() => {
                if (!ignore) setLoadedKey(fetchKey);
            });
        return () => {
            ignore = true;
        };
    }, [automation, page, fetchKey, refreshTick]);

    const columns: ColumnsType<AutomationRunView> = [
        {
            title: '计划时间',
            dataIndex: 'scheduledAt',
            render: (ts: number) => dayjs(ts).format('YYYY-MM-DD HH:mm:ss')
        },
        {
            title: '结果',
            dataIndex: 'outcome',
            render: (outcome: AutomationRunView['outcome']) => {
                const tag = outcomeTag(outcome);
                return <Tag color={tag.color}>{tag.text}</Tag>;
            }
        },
        {
            title: '耗时',
            render: (_: unknown, r) => duration(r.startedAt, r.endedAt)
        },
        {
            title: '步数',
            dataIndex: 'steps',
            render: (steps?: number) => steps ?? '-'
        },
        {
            title: '错误',
            dataIndex: 'error',
            render: (error?: string) =>
                error ? <span style={{ color: 'var(--color-error)', wordBreak: 'break-all' }}>{error}</span> : '-'
        }
    ];

    return (
        <Drawer
            // 渲染在页面内容区（相对定位容器）内、而非 portal 到 body：抽屉从表头下方展开，
            // 关闭按钮不再落进 PageHeader 的窗口拖拽区（-webkit-app-region: drag），否则在客户端点不动。
            getContainer={false}
            // 不要遮罩：抽屉下方列表仍可操作，也不会用半透明层盖住页面。
            mask={false}
            title={automation ? `运行历史 · ${automation.title}` : '运行历史'}
            open={!!automation}
            onClose={onClose}
            size={640}
        >
            {runs.length === 0 && !loading ? (
                <Empty description="暂无运行记录" />
            ) : (
                <Table<AutomationRunView>
                    rowKey="runId"
                    size="small"
                    loading={loading}
                    columns={columns}
                    dataSource={runs}
                    pagination={{
                        current: page,
                        pageSize: PAGE_SIZE,
                        total,
                        onChange: setPage,
                        showSizeChanger: false
                    }}
                />
            )}
        </Drawer>
    );
}
