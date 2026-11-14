import { AppstoreOutlined, BarsOutlined, LeftOutlined } from '@ant-design/icons';
import { useMount, useRequest } from 'ahooks';
import { App, Button, Empty, Input, Segmented, Select, Spin } from 'antd';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import PageHeader from '@/components/PageHeader';
import { SUCCESS_CODE } from '@/constant/code';
import { installSkillHubApi, searchSkillHubApi, type SkillHubSearchParams } from '@/services';
import type { MarketSkillCard as CardType } from '@/types/skillhub';

import { MarketSkillCard } from './components/MarketSkillCard';
import { MarketSkillRow } from './components/MarketSkillRow';
import { formatCount } from './format';
import useStyles from './styles';

// 排序标签对齐 SkillHub 官方；注意上游 /api/skills 仅支持 score/downloads/stars/installs/updated_at，
// 官方「近期飙升」(trending) 不在该接口支持范围内，故此处用「收藏」(stars) 取代。
const SORT_OPTIONS = [
    { value: 'score', label: '全部' },
    { value: 'downloads', label: '下载量' },
    { value: 'stars', label: '收藏' },
    { value: 'updated_at', label: '最近上新' }
];

// 场景分类（key→中文，与后端 CATEGORY_LABELS 一致）；空 value 表示全部。
const CATEGORY_OPTIONS = [
    { value: '', label: '所有场景分类' },
    { value: 'office-efficiency', label: '办公效率' },
    { value: 'content-creation', label: '内容创作' },
    { value: 'dev-programming', label: '开发编程' },
    { value: 'data-analysis', label: '数据分析' },
    { value: 'design-media', label: '设计多媒体' },
    { value: 'ai-agent', label: 'AI Agent' },
    { value: 'knowledge-management', label: '知识管理' },
    { value: 'business-ops', label: '商业运营' },
    { value: 'education', label: '教育学习' },
    { value: 'professional', label: '行业专业' },
    { value: 'it-ops-security', label: 'IT 运维与安全' },
    { value: 'life-service', label: '生活服务' }
];

// 来源：对齐官方「所有来源 / ClawHub / SkillHub」，SkillHub 实际对应 source=community。
const SOURCE_OPTIONS = [
    { value: '', label: '所有来源' },
    { value: 'clawhub', label: 'ClawHub' },
    { value: 'community', label: 'SkillHub' }
];

const VIEW_OPTIONS = [
    { value: 'list', icon: <BarsOutlined /> },
    { value: 'grid', icon: <AppstoreOutlined /> }
];

// 技能的唯一身份：优先 canonicalName（`@namespace/slug`），回退 slug。
// 注意：SkillHub 允许不同 namespace 发布同一 slug（如两个 dev-expert），只按 slug 去重 / 作 React key
// 会把两个不同技能当成同一个（重复 key + 列表看起来“重复”）。
const skillKey = (s: Pick<CardType, 'slug' | 'canonicalName'>) => s.canonicalName || s.slug;

export function SkillMarketPage() {
    const { styles, cx } = useStyles();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();

    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('score');
    const [category, setCategory] = useState('');
    const [source, setSource] = useState('');
    const [view, setView] = useState<'list' | 'grid'>('list');
    const [items, setItems] = useState<CardType[]>([]);
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [total, setTotal] = useState(0);
    const [installingSlug, setInstallingSlug] = useState<string | null>(null);

    // 搜索：append=false 为新搜索（重置列表），append=true 为「加载更多」
    const { loading, run: runSearch } = useRequest(
        async (params: SkillHubSearchParams, append: boolean) => {
            const res = await searchSkillHubApi(params);
            if (res.code !== SUCCESS_CODE || !res.data) throw new Error(res.message || '搜索失败');
            return { data: res.data, append };
        },
        {
            manual: true,
            onSuccess: ({ data, append }) => {
                setItems((prev) => {
                    if (!append) return data.items;
                    const seen = new Set(prev.map(skillKey));
                    return [...prev, ...data.items.filter((it) => !seen.has(skillKey(it)))];
                });
                setOffset(data.offset + data.items.length);
                setHasMore(data.hasMore);
                setTotal(data.total);
            }
        }
    );

    // 统一出口：合并当前筛选态 + 覆盖项发起搜索。关键词/排序/分类/来源任一变化走此函数，
    // 把变化项作为 override 传入（避免读到旧的 state 闭包值），其余从当前 state 取。
    const buildAndRun = useCallback(
        (over: {
            q?: string;
            sort?: string;
            category?: string;
            source?: string;
            offset?: number;
            append?: boolean;
        }) => {
            runSearch(
                {
                    q: ((over.q ?? query).trim() || undefined) as string | undefined,
                    sort: over.sort ?? sort,
                    category: (over.category ?? category) || undefined,
                    source: (over.source ?? source) || undefined,
                    limit: 12,
                    offset: over.offset ?? 0
                },
                over.append ?? false
            );
        },
        [runSearch, query, sort, category, source]
    );

    const doSearch = useCallback((q: string) => buildAndRun({ q, offset: 0 }), [buildAndRun]);

    // 切换排序 / 分类 / 来源即时按当前筛选重拉，不必再点一次搜索。
    const handleSortChange = useCallback(
        (v: string) => {
            setSort(v);
            buildAndRun({ sort: v, offset: 0 });
        },
        [buildAndRun]
    );
    const handleCategoryChange = useCallback(
        (v: string) => {
            setCategory(v);
            buildAndRun({ category: v, offset: 0 });
        },
        [buildAndRun]
    );
    const handleSourceChange = useCallback(
        (v: string) => {
            setSource(v);
            buildAndRun({ source: v, offset: 0 });
        },
        [buildAndRun]
    );

    const loadMore = useCallback(() => buildAndRun({ offset, append: true }), [buildAndRun, offset]);

    // 进入广场即拉一份推荐列表（空关键词 = 浏览热门，按 score 排序），不必等用户先搜索。
    useMount(() => buildAndRun({}));

    // 安装成功后把对应卡片标为已安装：按唯一身份（canonicalName 优先）精确匹配，避免把同 slug 的
    // 另一个技能也误标成已安装。
    const markInstalled = useCallback((installed: { slug: string; canonicalName?: string }) => {
        const key = skillKey(installed);
        setItems((prev) => prev.map((it) => (skillKey(it) === key ? { ...it, installed: true } : it)));
    }, []);

    const { loading: installing, run: runInstall } = useRequest(
        async (slug: string, version?: string, canonicalName?: string, displayName?: string) => {
            const res = await installSkillHubApi(slug, version, canonicalName, displayName);
            if (res.code !== SUCCESS_CODE || !res.data) throw new Error(res.message || '安装失败');
            return res.data;
        },
        {
            manual: true,
            onBefore: ([slug, , canonicalName]) => setInstallingSlug(canonicalName || slug),
            onSuccess: (data) => {
                markInstalled(data);
                message.success('技能已安装，新对话即可使用。');
            },
            onError: (e) => message.error(e.message),
            onFinally: () => setInstallingSlug(null)
        }
    );

    // D2：风险 / 可疑技能安装前二次确认
    const handleInstall = useCallback(
        (skill: CardType) => {
            const { slug, version, canonicalName, name } = skill;
            const worst = skill.security?.worst;
            if (worst === 'malicious' || worst === 'suspicious') {
                modal.confirm({
                    title: worst === 'malicious' ? '该技能被标记为风险' : '该技能被标记为可疑',
                    content: '安全扫描对该技能有风险提示，技能内容来自第三方。确认仍要安装吗？',
                    okText: '仍然安装',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    centered: true,
                    onOk: () => runInstall(slug, version, canonicalName, name)
                });
                return;
            }
            runInstall(slug, version, canonicalName, name);
        },
        [modal, runInstall]
    );

    // 点卡片 → 跳独立详情页。把 canonicalName 放进 URL 的 ns（直达 / 刷新不丢消歧信息），并把当前卡片经
    // 路由 state 带过去作兜底（详情接口对部分 slug 稀疏）。
    const handleShowDetail = useCallback(
        (skill: CardType) => {
            const suffix = skill.canonicalName ? `?ns=${encodeURIComponent(skill.canonicalName)}` : '';
            navigate(`/skill-market/skills/${encodeURIComponent(skill.slug)}${suffix}`, { state: { card: skill } });
        },
        [navigate]
    );

    return (
        <div className={cx('skill-market-page', styles.toString())}>
            <PageHeader>
                <Button type="text" icon={<LeftOutlined />} onClick={() => navigate('/skills')}>
                    返回
                </Button>
                <span className="skill-market-topbar-title">技能广场</span>
            </PageHeader>

            <div className="skill-market-body">
                <div className="skill-market-sticky">
                    <div className="skill-market-heading">
                        <h1 className="skill-market-h1">全部技能</h1>
                        <span className="skill-market-sub">
                            快速发现专家技能，让 AI 从通用走向专用
                            {total > 0 ? ` · 共 ${formatCount(total)} 个技能` : ''}
                        </span>
                    </div>

                    <div className="skill-market-toolbar">
                        <Segmented value={sort} onChange={(v) => handleSortChange(String(v))} options={SORT_OPTIONS} />
                        <div className="skill-market-filters">
                            <Select
                                value={source}
                                onChange={handleSourceChange}
                                options={SOURCE_OPTIONS}
                                style={{ width: 128 }}
                            />
                            <Select
                                value={category}
                                onChange={handleCategoryChange}
                                options={CATEGORY_OPTIONS}
                                style={{ width: 148 }}
                            />
                            <Segmented
                                value={view}
                                onChange={(v) => setView(v as 'list' | 'grid')}
                                options={VIEW_OPTIONS}
                            />
                        </div>
                    </div>

                    <div className="skill-market-search-wrap">
                        <Input.Search
                            style={{ width: '100%' }}
                            placeholder="搜索技能名称、描述或关键词..."
                            allowClear
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onSearch={doSearch}
                        />
                    </div>
                </div>

                <div className="skill-market-scroll">
                    <div className="skill-market-content">
                        {loading && items.length === 0 ? (
                            <div className="skill-market-loading">
                                <Spin />
                            </div>
                        ) : items.length === 0 ? (
                            <Empty description="没有找到相关技能，换个关键词试试" />
                        ) : (
                            <>
                                <div className={view === 'grid' ? 'skill-market-grid' : 'skill-market-list'}>
                                    {items.map((it) =>
                                        view === 'grid' ? (
                                            <MarketSkillCard
                                                key={skillKey(it)}
                                                skill={it}
                                                installing={installing && installingSlug === skillKey(it)}
                                                onShowDetail={handleShowDetail}
                                                onInstall={handleInstall}
                                            />
                                        ) : (
                                            <MarketSkillRow
                                                key={skillKey(it)}
                                                skill={it}
                                                installing={installing && installingSlug === skillKey(it)}
                                                onShowDetail={handleShowDetail}
                                                onInstall={handleInstall}
                                            />
                                        )
                                    )}
                                </div>
                                {hasMore && (
                                    <div className="skill-market-more">
                                        <Button loading={loading} onClick={loadMore}>
                                            加载更多
                                        </Button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default SkillMarketPage;
