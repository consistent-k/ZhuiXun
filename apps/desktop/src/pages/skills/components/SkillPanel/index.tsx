import { PlusOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { Button, Input, Space, Upload } from 'antd';
import { useMemo, useState } from 'react';

import { spacing } from '@/theme/tokens';
import type { LoadedSkill, SkillSource } from '@/types/skill';

import { SkillCard } from '../SkillCard';

import useStyles from './styles';

interface SkillPanelProps {
    skills: LoadedSkill[];
    onShowDetail?: (skill: LoadedSkill) => void;
    onCreate?: () => void;
    onEdit?: (skill: LoadedSkill) => void;
    onDelete?: (skill: LoadedSkill) => void;
    onToggle?: (skill: LoadedSkill) => void;
    onExport?: (skill: LoadedSkill) => void;
    onUpload?: (file: File) => void;
}

type SourceFilter = 'all' | SkillSource;

const SOURCE_FILTERS: Array<{ id: SourceFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'builtin', label: '共享技能' },
    { id: 'user', label: '用户技能' }
];

export function SkillPanel({
    skills,
    onShowDetail,
    onCreate,
    onEdit,
    onDelete,
    onToggle,
    onExport,
    onUpload
}: SkillPanelProps) {
    const { styles, cx } = useStyles();
    const [searchText, setSearchText] = useState('');
    const [activeSource, setActiveSource] = useState<SourceFilter>('all');

    const filteredSkills = useMemo(() => {
        const list = skills.filter((skill) => {
            const matchesSearch = skill.name.includes(searchText) || skill.description.includes(searchText);
            const matchesSource = activeSource === 'all' || skill.source === activeSource;
            return matchesSearch && matchesSource;
        });
        // 用户技能优先展示，其次共享技能；同来源保持原顺序（稳定排序）
        const sourceWeight = (s: LoadedSkill) => (s.source === 'user' ? 0 : 1);
        return list.sort((a, b) => sourceWeight(a) - sourceWeight(b));
    }, [skills, searchText, activeSource]);

    return (
        <div className={cx('skill-panel', styles.toString())}>
            <div className="skill-panel-toolbar">
                <span className="skill-panel-count">共 {skills.length} 个技能</span>
                <Space size={spacing.xs}>
                    <Input
                        className="skill-panel-search-input"
                        placeholder="搜索技能..."
                        allowClear
                        prefix={<SearchOutlined />}
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                    />
                    <Upload
                        accept=".md,.zip"
                        showUploadList={false}
                        beforeUpload={(file) => {
                            onUpload?.(file);
                            return false;
                        }}
                    >
                        <Button icon={<UploadOutlined />}>上传</Button>
                    </Upload>
                    <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
                        新增
                    </Button>
                </Space>
            </div>

            <div className="skill-panel-category-bar">
                {SOURCE_FILTERS.map((item) => (
                    <button
                        type="button"
                        key={item.id}
                        aria-pressed={activeSource === item.id}
                        className={cx('skill-panel-category-item', activeSource === item.id && 'active')}
                        onClick={() => setActiveSource(item.id)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>

            <div className="skill-panel-content">
                {filteredSkills.length > 0 ? (
                    <div className="skill-panel-grid">
                        {filteredSkills.map((skill) => (
                            <SkillCard
                                key={skill.id}
                                skill={skill}
                                onShowDetail={onShowDetail}
                                onEdit={onEdit}
                                onDelete={onDelete}
                                onToggle={onToggle}
                                onExport={onExport}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="skill-panel-empty">没有找到匹配的技能</div>
                )}
            </div>
        </div>
    );
}
