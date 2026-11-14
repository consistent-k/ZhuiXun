import { DeleteOutlined, DownloadOutlined, EditOutlined } from '@ant-design/icons';
import { Button, Popconfirm, Switch, Tag } from 'antd';
import type { MouseEvent } from 'react';

import type { LoadedSkill } from '@/types/skill';

import useStyles from './styles';

interface SkillCardProps {
    skill: LoadedSkill;
    onShowDetail?: (skill: LoadedSkill) => void;
    onEdit?: (skill: LoadedSkill) => void;
    onDelete?: (skill: LoadedSkill) => void;
    onToggle?: (skill: LoadedSkill) => void;
    onExport?: (skill: LoadedSkill) => void;
}

export function SkillCard({ skill, onShowDetail, onEdit, onDelete, onToggle, onExport }: SkillCardProps) {
    const { styles, cx } = useStyles();

    // 阻止操作控件冒泡触发卡片的「查看详情」
    const stop = (e: MouseEvent) => e.stopPropagation();

    return (
        <div
            className={cx('skill-card', styles.toString(), skill.disabled && 'disabled')}
            onClick={() => onShowDetail?.(skill)}
        >
            <div className="skill-card-header">
                <button
                    type="button"
                    className="skill-card-name"
                    title={skill.name}
                    onClick={(event) => {
                        stop(event);
                        onShowDetail?.(skill);
                    }}
                >
                    {skill.name}
                </button>
                <span className="skill-card-switch" onClick={stop}>
                    <Switch
                        size="small"
                        aria-label={`启用 ${skill.name}`}
                        checked={!skill.disabled}
                        onChange={() => onToggle?.(skill)}
                        checkedChildren="启用"
                        unCheckedChildren="停用"
                    />
                </span>
            </div>

            <span className="skill-card-description">{skill.description}</span>

            <div className="skill-card-footer">
                <div className="skill-card-meta">
                    {skill.source === 'builtin' ? <Tag color="default">共享</Tag> : <Tag color="blue">用户</Tag>}
                    <span className="skill-card-tool-count">{skill.tools.length} 个工具</span>
                </div>
                <div className="skill-card-actions" onClick={stop}>
                    <Button
                        type="text"
                        size="small"
                        icon={<DownloadOutlined />}
                        title="导出为 zip"
                        onClick={() => onExport?.(skill)}
                    />
                    {skill.editable && (
                        <>
                            <Button
                                type="text"
                                size="small"
                                icon={<EditOutlined />}
                                title="编辑"
                                onClick={() => onEdit?.(skill)}
                            />
                            <Popconfirm
                                title="删除该技能？"
                                description="删除后不可恢复"
                                okText="删除"
                                cancelText="取消"
                                okButtonProps={{ danger: true }}
                                onConfirm={() => onDelete?.(skill)}
                            >
                                <Button type="text" size="small" danger icon={<DeleteOutlined />} title="删除" />
                            </Popconfirm>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
