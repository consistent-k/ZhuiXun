import { DeleteOutlined, DownloadOutlined, EditOutlined } from '@ant-design/icons';
import { Button, Popconfirm, Switch, Tag, Typography } from 'antd';

import Modal from '@/components/Modal';
import type { LoadedSkill } from '@/types/skill';

import useStyles from './styles';

const { Paragraph } = Typography;

interface SkillDetailModalProps {
    skill: LoadedSkill | null;
    open: boolean;
    onClose: () => void;
    onEdit?: (skill: LoadedSkill) => void;
    onDelete?: (skill: LoadedSkill) => void;
    onToggle?: (skill: LoadedSkill) => void;
    onExport?: (skill: LoadedSkill) => void;
}

export function SkillDetailModal({
    skill,
    open,
    onClose,
    onEdit,
    onDelete,
    onToggle,
    onExport
}: SkillDetailModalProps) {
    const { styles, cx } = useStyles();

    if (!skill) return null;

    return (
        <Modal
            className={cx('skill-detail-modal', styles.toString())}
            open={open}
            onCancel={onClose}
            title={skill.name}
            footer={
                <div className="skill-detail-modal-actions">
                    <Switch
                        aria-label="启用技能"
                        checked={!skill.disabled}
                        onChange={() => onToggle?.(skill)}
                        checkedChildren="已启用"
                        unCheckedChildren="已停用"
                    />
                    <Button size="small" icon={<DownloadOutlined />} onClick={() => onExport?.(skill)}>
                        导出
                    </Button>
                    {skill.editable && (
                        <>
                            <Button
                                size="small"
                                icon={<EditOutlined />}
                                onClick={() => {
                                    onEdit?.(skill);
                                    onClose();
                                }}
                            >
                                编辑
                            </Button>
                            <Popconfirm
                                title="删除该技能？"
                                description="删除后不可恢复"
                                okText="删除"
                                cancelText="取消"
                                okButtonProps={{ danger: true }}
                                onConfirm={() => {
                                    onDelete?.(skill);
                                    onClose();
                                }}
                            >
                                <Button size="small" danger icon={<DeleteOutlined />}>
                                    删除
                                </Button>
                            </Popconfirm>
                        </>
                    )}
                </div>
            }
        >
            <Paragraph className="skill-detail-modal-description">{skill.description}</Paragraph>

            <div className="skill-detail-modal-section">
                <div className="skill-detail-modal-section-title">基本信息</div>
                <div className="skill-detail-modal-info-grid">
                    <div className="skill-detail-modal-info-row">
                        <span className="skill-detail-modal-info-label">技能 ID</span>
                        <span className="skill-detail-modal-info-value">{skill.id}</span>
                    </div>
                    <div className="skill-detail-modal-info-row">
                        <span className="skill-detail-modal-info-label">来源</span>
                        {skill.source === 'builtin' ? <Tag color="default">共享</Tag> : <Tag color="blue">用户</Tag>}
                    </div>
                    <div className="skill-detail-modal-info-row">
                        <span className="skill-detail-modal-info-label">状态</span>
                        {skill.disabled ? <Tag color="default">已停用</Tag> : <Tag color="green">已启用</Tag>}
                    </div>
                </div>
            </div>

            {skill.tools && skill.tools.length > 0 && (
                <div className="skill-detail-modal-section">
                    <div className="skill-detail-modal-section-title">工具能力（{skill.tools.length}）</div>
                    <div className="skill-detail-modal-tool-list">
                        {skill.tools.map((tool) => (
                            <div key={tool.name} className="skill-detail-modal-tool-item">
                                <div className="skill-detail-modal-tool-name">{tool.name}</div>
                                <div className="skill-detail-modal-tool-description">{tool.description}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </Modal>
    );
}
