import { DownloadOutlined, KeyOutlined, StarOutlined } from '@ant-design/icons';
import { Avatar, Button, Card, Tag } from 'antd';

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

/** 网格视图下的技能卡片（列表视图用 MarketSkillRow）。 */
export function MarketSkillCard({ skill, installing, onShowDetail, onInstall }: Props) {
    const sec = skill.security ? SECURITY_META[skill.security.worst] : null;
    return (
        <Card className="market-grid-card" hoverable size="small" onClick={() => onShowDetail(skill)}>
            <div className="market-grid-head">
                <Avatar className="market-grid-icon" shape="square" size={36} src={skill.iconUrl}>
                    {skill.name.slice(0, 1)}
                </Avatar>
                <span className="market-grid-name" title={skill.name}>
                    {skill.name}
                </span>
            </div>
            <div className="market-grid-tags">
                {skill.categoryLabel && <Tag>{skill.categoryLabel}</Tag>}
                {skill.verified && <Tag color="blue">认证</Tag>}
                {skill.requiresApiKey && (
                    <Tag icon={<KeyOutlined />} color="gold">
                        API Key
                    </Tag>
                )}
                {sec && <Tag color={sec.color}>{sec.text}</Tag>}
            </div>
            <div className="market-grid-desc">{skill.description || '暂无简介'}</div>
            <div className="market-grid-foot" onClick={(e) => e.stopPropagation()}>
                <span className="market-grid-stat">
                    <StarOutlined /> {formatCount(skill.stars)}
                </span>
                <span className="market-grid-stat">
                    <DownloadOutlined /> {formatCount(skill.downloads)}
                </span>
                <Button
                    type={skill.installed ? 'default' : 'primary'}
                    size="small"
                    loading={installing}
                    disabled={skill.installed}
                    onClick={() => onInstall(skill)}
                    style={{ marginLeft: 'auto' }}
                >
                    {skill.installed ? '已安装' : '安装'}
                </Button>
            </div>
        </Card>
    );
}

export default MarketSkillCard;
