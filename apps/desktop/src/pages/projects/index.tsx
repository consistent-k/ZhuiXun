import { LeftOutlined, SaveOutlined, FolderOpenOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Card, Empty, Input, Select, Space, Spin, Switch, Tag } from 'antd';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import MemoryItems from '@/components/MemoryItems';
import PageHeader from '@/components/PageHeader';
import { SUCCESS_CODE } from '@/constant/code';
import { fetchProjectApi, fetchSkillsApi, validateProjectPathApi } from '@/services';
import { useProjectStore } from '@/stores';
import { spacing } from '@/theme/tokens';
import type { ProjectRoot } from '@/types/project';

import { DirectoryPickerModal } from './components/DirectoryPickerModal';
import useStyles from './styles';

const { TextArea } = Input;

const ProjectSettingsPage = () => {
    const { styles, cx } = useStyles();
    const navigate = useNavigate();
    const { projectId } = useParams();
    const { message, modal } = App.useApp();

    const [name, setName] = useState('');
    const [instructions, setInstructions] = useState('');
    const [defaultSkillId, setDefaultSkillId] = useState<string | undefined>();
    const [skillPreset, setSkillPreset] = useState<string[]>([]);
    // 工作目录集合（primary=会话 shell cwd，其余为附加根）
    const [roots, setRoots] = useState<ProjectRoot[]>([]);
    // 是否信任（信任后其根范围内安全命令/写入自动放行）；独立于表单保存，经确认后即时写穿
    const [trusted, setTrusted] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [saving, setSaving] = useState(false);

    // 项目详情：projectId 变化时重拉，回填表单
    const { data: project, loading: projectLoading } = useRequest(
        async () => {
            if (!projectId) return null;
            const res = await fetchProjectApi(projectId);
            return res.code === SUCCESS_CODE ? res.data : null;
        },
        {
            refreshDeps: [projectId],
            ready: !!projectId,
            onSuccess: (data) => {
                if (!data) return;
                setName(data.name);
                setInstructions(data.instructions ?? '');
                setDefaultSkillId(data.defaultSkillId);
                setSkillPreset(data.skillPreset ?? []);
                setRoots(data.roots ?? []);
                setTrusted(!!data.trusted);
            }
        }
    );

    // 技能列表：用于默认技能 / 技能集选择
    const { data: skills = [] } = useRequest(async () => {
        const res = await fetchSkillsApi();
        return res.code === SUCCESS_CODE && res.data ? res.data : [];
    });

    const skillOptions = skills.filter((s) => !s.disabled).map((s) => ({ label: s.name, value: s.id }));

    // 规范化：保证有且仅一个 primary（无显式则第一个为主）
    const withOnePrimary = (list: ProjectRoot[]): ProjectRoot[] => {
        if (list.length === 0) return [];
        const found = list.findIndex((r) => r.primary);
        const idx = found >= 0 ? found : 0;
        return list.map((r, i) => ({ path: r.path, primary: i === idx }));
    };

    // 从后端目录浏览器选完目录：校验后加入 roots（去重，首个自动为主根）
    const handlePickDir = async (picked: string) => {
        setPickerOpen(false);
        const path = picked.trim();
        if (!path) return;
        if (roots.some((r) => r.path === path)) {
            message.info('该目录已在列表中');
            return;
        }
        const res = await validateProjectPathApi(path);
        if (!(res.code === SUCCESS_CODE && res.data?.ok)) {
            message.error(`目录无效：${res.data?.reason ?? '不可访问'}`);
            return;
        }
        setRoots((prev) => withOnePrimary([...prev, { path, primary: prev.length === 0 }]));
    };

    const removeRoot = (path: string) => setRoots((prev) => withOnePrimary(prev.filter((r) => r.path !== path)));
    const setPrimaryRoot = (path: string) =>
        setRoots((prev) => prev.map((r) => ({ path: r.path, primary: r.path === path })));

    // 信任开关：开启需二次确认（说明自动放行范围与风险），关闭直接写穿
    const handleTrustChange = (next: boolean) => {
        if (!projectId) return;
        const apply = async () => {
            await useProjectStore.getState().trustProject(projectId, next);
            setTrusted(next);
            message.success(next ? '已信任该项目目录' : '已取消信任');
        };
        if (next) {
            modal.confirm({
                title: '信任此项目目录？',
                content:
                    '信任后，在该项目对话中，落在其任一工作目录范围内的「安全命令」与文件写入将自动放行、不再逐条确认；复合/危险命令、目录外操作仍会确认。请仅对你信任的本地目录开启。',
                okText: '信任并开启',
                cancelText: '取消',
                centered: true,
                okButtonProps: { danger: true },
                onOk: apply
            });
        } else {
            void apply();
        }
    };

    const handleSave = async () => {
        if (!projectId) return;
        if (!name.trim()) {
            message.warning('请输入项目名称');
            return;
        }
        setSaving(true);
        try {
            await useProjectStore.getState().updateProject(projectId, {
                name: name.trim(),
                instructions,
                defaultSkillId,
                skillPreset,
                roots
            });
            message.success('项目已保存');
        } finally {
            setSaving(false);
        }
    };

    if (!projectId) {
        return (
            <div className={cx('project-settings', styles.toString())}>
                <Empty description="未指定项目" />
            </div>
        );
    }

    return (
        <div className={cx('project-settings', styles.toString())}>
            <PageHeader gap={spacing.md} paddingBlock={spacing.md}>
                <Button type="text" icon={<LeftOutlined />} onClick={() => navigate(-1)}>
                    返回
                </Button>
                <span className="project-settings-title">项目设置{project ? ` · ${project.name}` : ''}</span>
                <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
                    保存
                </Button>
            </PageHeader>

            <div className="project-settings-scroll">
                <Spin spinning={projectLoading}>
                    <div className="project-settings-body">
                        <Card title="基本信息" size="small">
                            <div className="project-field">
                                <label>项目名称</label>
                                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="项目名称" />
                            </div>
                        </Card>

                        <Card
                            title="项目指令"
                            size="small"
                            extra={<span className="project-hint">该项目内所有会话都会带上这段设定</span>}
                        >
                            <TextArea
                                value={instructions}
                                onChange={(e) => setInstructions(e.target.value)}
                                rows={8}
                                placeholder="如：优先引用项目文档，按要点输出，并标注待确认事项"
                            />
                        </Card>

                        <Card title="默认能力" size="small">
                            <div className="project-field">
                                <label>新会话默认技能</label>
                                <Select
                                    allowClear
                                    value={defaultSkillId}
                                    onChange={setDefaultSkillId}
                                    options={skillOptions}
                                    placeholder="不指定（自动路由）"
                                    style={{ width: '100%' }}
                                />
                            </div>
                            <div className="project-field">
                                <label>技能集（限定路由模式可用技能，为空则不限定）</label>
                                <Select
                                    mode="multiple"
                                    allowClear
                                    value={skillPreset}
                                    onChange={setSkillPreset}
                                    options={skillOptions}
                                    placeholder="不限定"
                                    style={{ width: '100%' }}
                                />
                            </div>
                        </Card>

                        <Card
                            title="工作目录"
                            size="small"
                            extra={
                                <Button size="small" icon={<PlusOutlined />} onClick={() => setPickerOpen(true)}>
                                    添加目录
                                </Button>
                            }
                        >
                            {roots.length === 0 ? (
                                <div className="project-hint">
                                    未配置工作目录，会话将使用默认临时工作区。点「添加目录」从服务器文件系统选择（浏览器
                                    / 桌面端一致），可添加多个；其一为主目录（会话 shell
                                    的当前目录），其余为可访问的附加目录。
                                </div>
                            ) : (
                                <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                                    {roots.map((r) => (
                                        <div key={r.path} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <FolderOpenOutlined />
                                            <span
                                                style={{
                                                    flex: 1,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap'
                                                }}
                                                title={r.path}
                                            >
                                                {r.path}
                                            </span>
                                            {r.primary ? (
                                                <Tag color="blue">主目录</Tag>
                                            ) : (
                                                <Button type="link" size="small" onClick={() => setPrimaryRoot(r.path)}>
                                                    设为主目录
                                                </Button>
                                            )}
                                            <Button
                                                type="text"
                                                size="small"
                                                danger
                                                icon={<DeleteOutlined />}
                                                onClick={() => removeRoot(r.path)}
                                            />
                                        </div>
                                    ))}
                                </Space>
                            )}

                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: spacing.md,
                                    marginTop: spacing.md
                                }}
                            >
                                <div>
                                    <div style={{ fontWeight: 500 }}>信任此项目目录</div>
                                    <div className="project-hint">
                                        开启后，此项目对话中落在上述目录范围内的安全命令与文件写入自动放行（复合/危险命令、目录外仍确认）。仅对你信任的本地目录开启。
                                    </div>
                                </div>
                                <Switch checked={trusted} disabled={roots.length === 0} onChange={handleTrustChange} />
                            </div>
                        </Card>

                        <Card
                            title="项目记忆"
                            size="small"
                            extra={<span className="project-hint">仅本项目可见的长期记忆，按需提供给智能体</span>}
                        >
                            <MemoryItems scope="project" projectId={projectId} />
                        </Card>
                    </div>
                </Spin>
            </div>

            <DirectoryPickerModal
                open={pickerOpen}
                initialPath={roots.find((r) => r.primary)?.path ?? roots[0]?.path}
                onSelect={handlePickDir}
                onClose={() => setPickerOpen(false)}
            />
        </div>
    );
};

export default ProjectSettingsPage;
