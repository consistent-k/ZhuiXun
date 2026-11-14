import { ReloadOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Empty, List, Popconfirm, Spin } from 'antd';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchProjectsApi } from '@/services';
import { useProjectStore } from '@/stores';
import type { ProjectMeta } from '@/types/project';

/**
 * 项目回收站（设置页全局模块）：列出软删项目，支持恢复或彻底删除。
 * 软删时会话已复位未分组，故彻底删除默认非级联（不动会话）。
 */
export function RecycleBinPanel() {
    const { message } = App.useApp();
    const { data, loading, refresh } = useRequest(async () => {
        const res = await fetchProjectsApi(true);
        return res.code === SUCCESS_CODE && res.data ? res.data.filter((p) => p.deleted) : [];
    });
    const deleted: ProjectMeta[] = data ?? [];

    const handleRestore = async (id: string) => {
        await useProjectStore.getState().restoreProject(id);
        message.success('项目已恢复');
        refresh();
    };

    const handleHardDelete = async (id: string) => {
        await useProjectStore.getState().hardDeleteProject(id, false);
        message.success('项目已彻底删除');
        refresh();
    };

    return (
        <div>
            <div className="settings-page-toolbar">
                <span className="settings-page-hint">
                    恢复或彻底删除已删除的项目（删除默认可恢复，不会清掉项目指令与记忆）
                </span>
                <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>
                    刷新
                </Button>
            </div>
            <Spin spinning={loading}>
                {deleted.length === 0 ? (
                    <Empty
                        className="settings-page-empty"
                        description="回收站为空"
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                ) : (
                    <List
                        className="settings-page-recycle-list"
                        dataSource={deleted}
                        renderItem={(p) => (
                            <List.Item
                                actions={[
                                    <Button key="restore" type="link" onClick={() => handleRestore(p.id)}>
                                        恢复
                                    </Button>,
                                    <Popconfirm
                                        key="hard"
                                        title="彻底删除该项目？"
                                        description="将连同项目指令与项目记忆一并永久删除，不可恢复。其会话已在删除时移到未分组、不受影响。"
                                        okText="彻底删除"
                                        okButtonProps={{ danger: true }}
                                        onConfirm={() => handleHardDelete(p.id)}
                                    >
                                        <Button type="link" danger>
                                            彻底删除
                                        </Button>
                                    </Popconfirm>
                                ]}
                            >
                                <List.Item.Meta
                                    title={p.name}
                                    description={p.roots?.length ? `${p.roots.length} 个工作目录` : '无工作目录'}
                                />
                            </List.Item>
                        )}
                    />
                )}
            </Spin>
        </div>
    );
}

export default RecycleBinPanel;
