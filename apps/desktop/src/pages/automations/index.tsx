import { PlusOutlined } from '@ant-design/icons';
import { App, Button, Empty, Segmented } from 'antd';
import { useEffect, useState } from 'react';

import PageHeader from '@/components/PageHeader';
import { useAutomationStore } from '@/stores';
import type { AutomationFilter, AutomationSchedule, AutomationView } from '@/types/automation';

import AutomationEditModal from './components/AutomationEditModal';
import AutomationTable from './components/AutomationTable';
import RunHistoryDrawer from './components/RunHistoryDrawer';
import useStyles from './styles';

const FILTER_OPTIONS: { value: AutomationFilter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'enabled', label: '已启用' },
    { value: 'inactive', label: '已停用' }
];

const AutomationsPage = () => {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const {
        automations,
        filter,
        loading,
        refresh,
        setFilter,
        create,
        update,
        remove,
        setEnabled,
        runNow,
        subscribe,
        clearUnseen
    } = useAutomationStore();

    const [editOpen, setEditOpen] = useState(false);
    const [editing, setEditing] = useState<AutomationView | null>(null);
    const [historyTarget, setHistoryTarget] = useState<AutomationView | null>(null);

    // 首次加载 + 挂 SSE：事件到达就地重拉；打开本页即清掉侧栏未读角标
    useEffect(() => {
        void refresh();
        clearUnseen();
        const unsubscribe = subscribe();
        return unsubscribe;
    }, [refresh, subscribe, clearUnseen]);

    const openCreate = () => {
        setEditing(null);
        setEditOpen(true);
    };
    const openEdit = (row: AutomationView) => {
        setEditing(row);
        setEditOpen(true);
    };

    const handleSubmit = async (values: {
        title: string;
        prompt: string;
        schedule: AutomationSchedule;
        enabled: boolean;
    }) => {
        const ok = editing
            ? await update(editing.id, values)
            : await create({
                  title: values.title,
                  prompt: values.prompt,
                  schedule: values.schedule,
                  enabled: values.enabled
              });
        if (ok) {
            message.success(editing ? '已保存' : '已创建');
            setEditOpen(false);
        }
    };

    const handleRun = async (row: AutomationView) => {
        const runId = await runNow(row.id);
        if (runId) message.success('已触发一次运行');
    };

    const handleDelete = async (row: AutomationView) => {
        await remove(row.id);
        message.success('已删除');
    };

    return (
        <div className={cx('automations-page', styles.toString())}>
            <PageHeader>
                <span className="automations-title">自动化任务</span>
            </PageHeader>
            <div className="automations-content">
                <div className="automations-scroll">
                    <div className="automations-toolbar">
                        <Segmented
                            options={FILTER_OPTIONS}
                            value={filter}
                            onChange={(v) => void setFilter(v as AutomationFilter)}
                        />
                        <Button
                            type="primary"
                            icon={<PlusOutlined />}
                            style={{ marginLeft: 'auto' }}
                            onClick={openCreate}
                        >
                            新建任务
                        </Button>
                    </div>

                    {automations.length === 0 && !loading ? (
                        <Empty description="还没有自动化任务，点右上角「新建任务」创建一个定时任务" />
                    ) : (
                        <AutomationTable
                            data={automations}
                            loading={loading}
                            onToggle={(row, enabled) => void setEnabled(row.id, enabled)}
                            onRun={(row) => void handleRun(row)}
                            onEdit={openEdit}
                            onDelete={(row) => void handleDelete(row)}
                            onHistory={setHistoryTarget}
                        />
                    )}
                </div>

                {/* 运行历史抽屉渲染在此容器内（getContainer={false}），从表头下方展开：
                    PageHeader 是窗口拖拽区(-webkit-app-region: drag)，抽屉若从视口顶部展开，
                    其头部关闭按钮会落进拖拽带、点击被吞，无法关闭。 */}
                <RunHistoryDrawer automation={historyTarget} onClose={() => setHistoryTarget(null)} />
            </div>

            <AutomationEditModal
                open={editOpen}
                editing={editing}
                onCancel={() => setEditOpen(false)}
                onSubmit={(values) => void handleSubmit(values)}
            />
        </div>
    );
};

export default AutomationsPage;
