import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Empty, Select, Space, Spin, Tag, Typography } from 'antd';
import { useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import {
    deletePersonaApi,
    fetchPersonasApi,
    setDefaultPersonaApi,
    type PersonaConfigView,
    type PersonaView
} from '@/services';
import { usePersonaStore } from '@/stores';

import { PersonaEditorModal } from './PersonaEditorModal';
import useStyles from './styles';

export function PersonaPanel() {
    const { styles, cx } = useStyles();
    const { message, modal } = App.useApp();
    const items = usePersonaStore((s) => s.items);
    const defaultId = usePersonaStore((s) => s.defaultId);
    const applyConfig = usePersonaStore((s) => s.applyConfig);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState<PersonaView | null>(null);
    const [editorMode, setEditorMode] = useState<'create' | 'edit' | 'copy'>('create');

    const { loading } = useRequest(
        async () => {
            const res = await fetchPersonasApi();
            return res.code === SUCCESS_CODE ? res.data : undefined;
        },
        {
            onSuccess: (config) => {
                if (config) applyConfig(config);
            }
        }
    );

    const { loading: savingDefault, run: saveDefault } = useRequest(
        async (nextId: string) => {
            const res = await setDefaultPersonaApi(nextId);
            if (res.code === SUCCESS_CODE && res.data) {
                applyConfig(res.data);
                message.success('默认风格已更新');
            }
        },
        { manual: true }
    );

    const openCreate = () => {
        setEditorMode('create');
        setEditing(null);
        setEditorOpen(true);
    };

    const openEdit = (persona: PersonaView) => {
        setEditorMode('edit');
        setEditing(persona);
        setEditorOpen(true);
    };

    const openCopy = (persona: PersonaView) => {
        setEditorMode('copy');
        setEditing(persona);
        setEditorOpen(true);
    };

    const handleSaved = (config: PersonaConfigView) => applyConfig(config);

    const handleDelete = (persona: PersonaView) => {
        modal.confirm({
            title: `删除「${persona.name}」？`,
            content: '引用该风格的会话会回落到默认风格，不会影响已经生成的回答。',
            okText: '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            centered: true,
            onOk: async () => {
                const res = await deletePersonaApi(persona.id);
                if (res.code === SUCCESS_CODE && res.data) {
                    applyConfig(res.data);
                    message.success('风格已删除');
                }
            }
        });
    };

    const defaultOptions = [
        {
            label: '内置',
            options: items
                .filter((item) => item.kind === 'builtin')
                .map((item) => ({ value: item.id, label: item.name }))
        },
        {
            label: '我的风格',
            options: items
                .filter((item) => item.kind === 'custom')
                .map((item) => ({ value: item.id, label: item.name }))
        }
    ].filter((group) => group.options.length > 0);

    return (
        <Spin spinning={loading} className={cx('persona-panel', styles.toString())}>
            <div className="persona-panel-header">
                <div>
                    <div className="persona-panel-hint">
                        风格只影响表达方式，不改变事实判断、工具权限与记忆事实。未单独指定风格的会话会跟随这里的默认选择。
                    </div>
                </div>
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                    新建风格
                </Button>
            </div>

            <div className="persona-panel-default">
                <span className="persona-panel-default-label">默认风格</span>
                <Select
                    className="persona-panel-default-select"
                    value={defaultId}
                    loading={savingDefault}
                    disabled={savingDefault || items.length === 0}
                    options={defaultOptions}
                    onChange={(nextId) => saveDefault(nextId)}
                />
            </div>

            {items.length === 0 ? (
                <Empty description="暂无可用风格" />
            ) : (
                <div className="persona-panel-grid">
                    {items.map((persona) => (
                        <div key={persona.id} className="persona-panel-card">
                            <div className="persona-panel-card-head">
                                <span className="persona-panel-card-name">{persona.name}</span>
                                <Space size={4}>
                                    {persona.kind === 'custom' && <Tag>自定义</Tag>}
                                    {persona.id === defaultId && <Tag color="gold">默认</Tag>}
                                </Space>
                            </div>
                            <div className="persona-panel-card-desc">{persona.description || '未填写简介'}</div>
                            <Typography.Paragraph
                                className="persona-panel-card-instruction"
                                ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}
                            >
                                {persona.instruction || '保持 追寻 现有的回答方式。'}
                            </Typography.Paragraph>
                            <Space wrap size={4} className="persona-panel-card-actions">
                                {persona.id !== defaultId && (
                                    <Button type="link" size="small" onClick={() => saveDefault(persona.id)}>
                                        设为默认
                                    </Button>
                                )}
                                {persona.kind === 'custom' && (
                                    <Button
                                        type="link"
                                        size="small"
                                        icon={<EditOutlined />}
                                        onClick={() => openEdit(persona)}
                                    >
                                        编辑
                                    </Button>
                                )}
                                <Button
                                    type="link"
                                    size="small"
                                    icon={<CopyOutlined />}
                                    onClick={() => openCopy(persona)}
                                >
                                    {persona.kind === 'custom' ? '复制' : '另存为'}
                                </Button>
                                {persona.kind === 'custom' && (
                                    <Button
                                        type="link"
                                        danger
                                        size="small"
                                        icon={<DeleteOutlined />}
                                        onClick={() => handleDelete(persona)}
                                    >
                                        删除
                                    </Button>
                                )}
                            </Space>
                        </div>
                    ))}
                </div>
            )}

            <PersonaEditorModal
                open={editorOpen}
                mode={editorMode}
                editing={editing}
                onCancel={() => setEditorOpen(false)}
                onSaved={handleSaved}
            />
        </Spin>
    );
}

export default PersonaPanel;
