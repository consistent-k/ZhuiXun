import { DownloadOutlined, KeyOutlined, StarOutlined } from '@ant-design/icons';
import { Avatar, Button, Tag } from 'antd';

import type { MarketSkillCard as Card$, SkillHubSecurityStatus } from '@/types/skillhub';

import { formatCount } from '../format';

const SECURITY_META: Record<SkillHubSecurityStatus, { color: string; text: string } | null> = {
    benign: { color: 'green', text: '安全' },
    scanning: { color: 'blue', text: '扫描中' },
    suspicious: { color: 'orange', text: '可疑' },
    malicious: { color: 'red', text: '风险' },
    unknown: null
};

interface Props {
    skill: Card$;
    installing: boolean;
    onShowDetail: (skill: Card$) => void;
    onInstall: (skill: Card$) => void;
}

export function MarketSkillRow({ skill, installing, onShowDetail, onInstall }: Props) {
    const sec = skill.security ? SECURITY_META[skill.security.worst] : null;
    const publisher = skill.publisherName || skill.owner;

    return (
        <div className="market-row" onClick={() => onShowDetail(skill)}>
            <Avatar className="market-row-icon" shape="square" size={40} src={skill.iconUrl}>
                {skill.name.slice(0, 1)}
            </Avatar>

            <div className="market-row-main">
                <div className="market-row-title">
                    <span className="market-row-name" title={skill.name}>
                        {skill.name}
                    </span>
                    {skill.categoryLabel && <Tag>{skill.categoryLabel}</Tag>}
                    {skill.verified && <Tag color="blue">认证</Tag>}
                    {skill.requiresApiKey && (
                        <Tag icon={<KeyOutlined />} color="gold">
                            需配置 API Key
                        </Tag>
                    )}
                    {sec && <Tag color={sec.color}>{sec.text}</Tag>}
                </div>
                <div className="market-row-desc">{skill.description || '暂无简介'}</div>
            </div>

            <div className="market-row-meta" onClick={(e) => e.stopPropagation()}>
                <span className="market-row-stat">
                    <StarOutlined /> {formatCount(skill.stars)}
                </span>
                <span className="market-row-stat">
                    <DownloadOutlined /> {formatCount(skill.downloads)}
                </span>
                {publisher && <span className="market-row-owner">{publisher}</span>}
                <Button
                    type={skill.installed ? 'default' : 'primary'}
                    size="small"
                    loading={installing}
                    disabled={skill.installed}
                    onClick={() => onInstall(skill)}
                >
                    {skill.installed ? '已安装' : '安装'}
                </Button>
            </div>
        </div>
    );
}

export default MarketSkillRow;
