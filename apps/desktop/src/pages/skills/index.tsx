import { AppstoreAddOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Tabs } from 'antd';
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router';

import PageHeader from '@/components/PageHeader';
import { SUCCESS_CODE } from '@/constant/code';
import { deleteSkillApi, fetchSkillsApi, getSkillExportUrl, toggleSkillApi, uploadSkillApi } from '@/services';
import type { LoadedSkill, SkillListItem } from '@/types/skill';

import { ConnectorPanel } from './components/ConnectorPanel';
import { SkillDetailModal } from './components/SkillDetailModal';
import { SkillForm } from './components/SkillForm';
import { SkillPanel } from './components/SkillPanel';
import useStyles from './styles';

type TabKey = 'skills' | 'connectors';

/** 后端技能列表项 → 前端 LoadedSkill */
function toLoadedSkill(s: SkillListItem): LoadedSkill {
    return {
        id: s.id,
        name: s.name,
        description: s.description,
        tools: (s.tools ?? []) as LoadedSkill['tools'],
        source: s.source,
        editable: s.editable,
        disabled: s.disabled
    };
}

export function SkillsPage() {
    const { styles, cx } = useStyles();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const [activeTab, setActiveTab] = useState<TabKey>('skills');
    const [selectedSkill, setSelectedSkill] = useState<LoadedSkill | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [formOpen, setFormOpen] = useState(false);
    const [editingSkillId, setEditingSkillId] = useState<string | null>(null);

    // 挂载即拉技能列表；增删改后调用 refresh() 重拉
    const { data: skills = [], refresh } = useRequest(
        async () => {
            const res = await fetchSkillsApi();
            return res.code === SUCCESS_CODE ? (res.data ?? []).map(toLoadedSkill) : [];
        },
        {
            // 详情面板同步：选中项若已被删除则清空，否则刷新引用
            onSuccess: (list) => setSelectedSkill((prev) => (prev ? list.find((s) => s.id === prev.id) || null : null))
        }
    );

    const handleShowDetail = useCallback((skill: LoadedSkill) => {
        setSelectedSkill(skill);
        setDetailOpen(true);
    }, []);

    const handleCreate = useCallback(() => {
        setEditingSkillId(null);
        setFormOpen(true);
    }, []);

    const handleEdit = useCallback((skill: LoadedSkill) => {
        setEditingSkillId(skill.id);
        setFormOpen(true);
    }, []);

    const handleDelete = useCallback(
        async (skill: LoadedSkill) => {
            const res = await deleteSkillApi(skill.id);
            if (res.code === SUCCESS_CODE) {
                message.success('技能已删除');
                refresh();
            }
        },
        [refresh, message]
    );

    const handleToggle = useCallback(
        async (skill: LoadedSkill) => {
            const res = await toggleSkillApi(skill.id);
            if (res.code === SUCCESS_CODE) {
                message.success(res.data?.disabled ? '已停用' : '已启用');
                refresh();
            }
        },
        [refresh, message]
    );

    const handleExport = useCallback((skill: LoadedSkill) => {
        // 后端返回 Content-Disposition: attachment，浏览器据此下载
        const a = document.createElement('a');
        a.href = getSkillExportUrl(skill.id);
        a.download = `${skill.id}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }, []);

    const handleUpload = useCallback(
        async (file: File) => {
            const res = await uploadSkillApi(file);
            if (res.code === SUCCESS_CODE) {
                message.success('技能已导入');
                refresh();
            }
        },
        [refresh, message]
    );

    return (
        <div className={cx('skills-page', styles.toString())}>
            <PageHeader className="skills-page-header">
                <span className="skills-page-title">技能与连接器</span>
                {activeTab === 'skills' && (
                    <Button
                        size="small"
                        icon={<AppstoreAddOutlined />}
                        style={{ marginLeft: 'auto' }}
                        onClick={() => navigate('/skill-market')}
                    >
                        技能广场
                    </Button>
                )}
            </PageHeader>
            <Tabs
                className="skills-page-tabs"
                classNames={{ body: 'skills-page-tab-body', content: 'skills-page-tab-content' }}
                activeKey={activeTab}
                destroyOnHidden
                onChange={(key) => setActiveTab(key as TabKey)}
                items={[
                    {
                        label: '技能',
                        key: 'skills',
                        children: (
                            <SkillPanel
                                skills={skills}
                                onShowDetail={handleShowDetail}
                                onCreate={handleCreate}
                                onEdit={handleEdit}
                                onDelete={handleDelete}
                                onToggle={handleToggle}
                                onExport={handleExport}
                                onUpload={handleUpload}
                            />
                        )
                    },
                    { label: '连接器', key: 'connectors', children: <ConnectorPanel /> }
                ]}
            />
            <SkillDetailModal
                skill={selectedSkill}
                open={detailOpen}
                onClose={() => setDetailOpen(false)}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onToggle={handleToggle}
                onExport={handleExport}
            />
            <SkillForm
                open={formOpen}
                editingSkillId={editingSkillId}
                onClose={() => setFormOpen(false)}
                onSubmitted={refresh}
            />
        </div>
    );
}

export default SkillsPage;
