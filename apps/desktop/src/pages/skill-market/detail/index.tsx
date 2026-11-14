import { LeftOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { XMarkdown } from '@ant-design/x-markdown';
import '@ant-design/x-markdown/themes/light.css';
import { useRequest } from 'ahooks';
import { App, Avatar, Button, Empty, Spin, Tabs, Tag, Timeline, Typography } from 'antd';
import { useCallback, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import PageHeader from '@/components/PageHeader';
import { SUCCESS_CODE } from '@/constant/code';
import { fetchSkillHubDetailApi, installSkillHubApi } from '@/services';
import type { MarketSkillCard, MarketSkillDetail, SkillHubSecurityStatus } from '@/types/skillhub';

import { formatCount } from '../format';

import useStyles from './styles';

/** 安全扫描器 key → 实验室展示名（对齐 SkillHub 官方详情页）。 */
const SCANNER_LABELS: Record<string, string> = {
    keen: '科恩实验室',
    sanbu: '云鼎实验室'
};

const SECURITY_META: Record<SkillHubSecurityStatus, { color: string; text: string } | null> = {
    benign: { color: 'green', text: '安全' },
    scanning: { color: 'blue', text: '扫描中' },
    suspicious: { color: 'orange', text: '可疑' },
    malicious: { color: 'red', text: '风险' },
    unknown: null
};

/** 合并详情卡片与列表兜底卡片：逐字段取详情真值，缺失回退列表卡片（detail 接口对部分 slug 返回稀疏）。 */
function mergeCard(
    detailCard: MarketSkillCard | undefined,
    fallback: MarketSkillCard | undefined
): MarketSkillCard | null {
    if (!detailCard) return fallback ?? null;
    if (!fallback) return detailCard;
    return {
        ...fallback,
        ...detailCard,
        description: detailCard.description || fallback.description,
        categoryLabel: detailCard.categoryLabel || fallback.categoryLabel,
        downloads: detailCard.downloads || fallback.downloads,
        stars: detailCard.stars || fallback.stars,
        installs: detailCard.installs || fallback.installs,
        owner: detailCard.owner || fallback.owner,
        overview: detailCard.overview || fallback.overview,
        canonicalName: detailCard.canonicalName || fallback.canonicalName
    };
}

export function SkillMarketDetailPage() {
    const { styles, cx } = useStyles();
    const navigate = useNavigate();
    const location = useLocation();
    const { slug = '' } = useParams();
    const [searchParams] = useSearchParams();
    const { message, modal, notification } = App.useApp();

    const fallback = (location.state as { card?: MarketSkillCard } | null)?.card;
    // 同 slug 跨 namespace 消歧：优先取 URL 上的 ns（直达 / 刷新也不丢），回退到列表带过来的卡片 canonicalName。
    const canonicalName = searchParams.get('ns') || fallback?.canonicalName || undefined;
    const [detail, setDetail] = useState<MarketSkillDetail | null>(null);
    const [installedLocal, setInstalledLocal] = useState(false);

    const { loading } = useRequest(
        async () => {
            const res = await fetchSkillHubDetailApi(slug, canonicalName);
            if (res.code === SUCCESS_CODE && res.data) setDetail(res.data);
            return res;
        },
        { refreshDeps: [slug, canonicalName] }
    );

    const card = mergeCard(detail?.card, fallback);
    const installed = installedLocal || !!card?.installed;
    const sec = card?.security ? SECURITY_META[card.security.worst] : null;

    const { loading: installing, run: runInstall } = useRequest(
        async () => {
            const res = await installSkillHubApi(card!.slug, card!.version, card!.canonicalName, card!.name);
            if (res.code !== SUCCESS_CODE || !res.data) throw new Error(res.message || '安装失败');
            return res.data;
        },
        {
            manual: true,
            onSuccess: () => {
                setInstalledLocal(true);
                message.success('技能已安装，新对话即可使用。');
                // 需配置 API Key 的技能：安装后引导到「设置 → 环境变量」统一配置（不在本页做配置块）。
                if (card?.requiresApiKey) {
                    notification.info({
                        title: '该技能需要配置 API Key',
                        description: '请前往「设置 → 环境变量」添加该技能所需的 Key / Token 后再使用。',
                        duration: 8,
                        actions: (
                            <Button
                                type="primary"
                                size="small"
                                onClick={() => {
                                    notification.destroy();
                                    navigate('/settings', { state: { tab: 'env' } });
                                }}
                            >
                                去配置
                            </Button>
                        )
                    });
                }
            },
            onError: (e) => message.error(e.message)
        }
    );

    // D2：风险 / 可疑技能安装前二次确认
    const handleInstall = useCallback(() => {
        const worst = card?.security?.worst;
        if (worst === 'malicious' || worst === 'suspicious') {
            modal.confirm({
                title: worst === 'malicious' ? '该技能被标记为风险' : '该技能被标记为可疑',
                content: '安全扫描对该技能有风险提示，技能内容来自第三方。确认仍要安装吗？',
                okText: '仍然安装',
                okButtonProps: { danger: true },
                cancelText: '取消',
                centered: true,
                onOk: () => runInstall()
            });
            return;
        }
        runInstall();
    }, [card, modal, runInstall]);

    return (
        <div className={cx('skill-detail-page', styles.toString())}>
            <PageHeader>
                <Button type="text" icon={<LeftOutlined />} onClick={() => navigate('/skill-market')}>
                    返回
                </Button>
                <span className="skill-detail-crumb">技能广场 / {card?.name || slug}</span>
            </PageHeader>

            {!card && loading ? (
                <div className="skill-detail-loading">
                    <Spin />
                </div>
            ) : !card ? (
                <Empty description="技能不存在或已下架" style={{ marginTop: 80 }} />
            ) : (
                <div className="skill-detail-body">
                    <div className="skill-detail-main">
                        <div className="skill-detail-head">
                            <Avatar className="skill-detail-icon" shape="square" size={56} src={card.iconUrl}>
                                {card.name.slice(0, 1)}
                            </Avatar>
                            <div className="skill-detail-headinfo">
                                <h1 className="skill-detail-name">{card.name}</h1>
                                {card.canonicalName && (
                                    <div className="skill-detail-canonical">{card.canonicalName}</div>
                                )}
                                <div className="skill-detail-tags">
                                    {card.categoryLabel && <Tag>{card.categoryLabel}</Tag>}
                                    {card.version && <Tag color="blue">v{card.version}</Tag>}
                                    {card.verified && (
                                        <Tag color="gold">认证{card.publisherName ? `·${card.publisherName}` : ''}</Tag>
                                    )}
                                    {sec && (
                                        <Tag color={sec.color} icon={<SafetyCertificateOutlined />}>
                                            {sec.text}
                                        </Tag>
                                    )}
                                    {card.source && <Tag>来源：{card.source}</Tag>}
                                </div>
                            </div>
                        </div>

                        <Tabs
                            className="skill-detail-tabs"
                            items={[
                                {
                                    key: 'overview',
                                    label: '概述',
                                    children: card.overview ? (
                                        <XMarkdown className="x-markdown-light" content={card.overview} />
                                    ) : (
                                        <Typography.Paragraph type="secondary">
                                            {card.description || '暂无概述'}
                                        </Typography.Paragraph>
                                    )
                                },
                                {
                                    key: 'versions',
                                    label: '版本历史',
                                    children:
                                        loading && !detail ? (
                                            <Spin />
                                        ) : detail && detail.versions.length > 0 ? (
                                            <Timeline
                                                items={detail.versions.map((v) => ({
                                                    children: (
                                                        <div>
                                                            <strong>v{v.version}</strong>
                                                            {v.changelog && (
                                                                <div className="skill-detail-changelog">
                                                                    {v.changelog}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )
                                                }))}
                                            />
                                        ) : (
                                            <Empty description="暂无版本历史" />
                                        )
                                },
                                {
                                    key: 'security',
                                    label: '安全扫描',
                                    children:
                                        card.security && Object.keys(card.security.reports).length > 0 ? (
                                            Object.entries(card.security.reports).map(([scanner, r]) => {
                                                const m = SECURITY_META[r.status];
                                                return (
                                                    <div key={scanner} className="skill-detail-scan">
                                                        <Tag color={m?.color}>{SCANNER_LABELS[scanner] || scanner}</Tag>
                                                        <span>{r.statusText || r.status}</span>
                                                    </div>
                                                );
                                            })
                                        ) : (
                                            <Empty description="暂无安全扫描信息" />
                                        )
                                }
                            ]}
                        />
                    </div>

                    <aside className="skill-detail-aside">
                        <div className="skill-detail-install-card">
                            <Button
                                type={installed ? 'default' : 'primary'}
                                size="large"
                                block
                                loading={installing}
                                disabled={installed}
                                onClick={handleInstall}
                            >
                                {installed ? '已安装' : '安装到本地'}
                            </Button>
                            <div className="skill-detail-stats">
                                <span>下载 {formatCount(card.downloads)}</span>
                                <span>收藏 {formatCount(card.stars)}</span>
                                {card.owner && <span>作者 {card.owner}</span>}
                            </div>
                            {card.pageUrl && (
                                <Typography.Link href={card.pageUrl} target="_blank" rel="noreferrer">
                                    在 SkillHub 查看
                                </Typography.Link>
                            )}
                        </div>
                    </aside>
                </div>
            )}
        </div>
    );
}

export default SkillMarketDetailPage;
