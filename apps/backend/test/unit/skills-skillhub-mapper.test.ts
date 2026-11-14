import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
    mapCard,
    mapDetail,
    mapDetailCard,
    mapSearch,
    mapSecurity,
    mapVersions,
    normalizeSkillHubId,
    normalizeSkillHubSkillMd,
    skillHubLocalId
} from '@/modules/skills/skillhub/mapper';

function frontmatter(markdown: string): Record<string, unknown> {
    return parse(markdown.split('\n---\n')[0].slice(4)) as Record<string, unknown>;
}

const skillMd = (fields: string, body = '# Body\n\nKeep [reference](references/guide.md).') =>
    `---\n${fields}\n---\n\n${body}\n`;

describe('SkillHub mapper security and card boundaries', () => {
    it.each([undefined, null, false, 1, 'benign', {}, { scanner: null }, { scanner: 'benign' }])(
        'ignores missing/invalid scanner maps: %j',
        (input) => {
            expect(mapSecurity(input)).toBeUndefined();
        }
    );

    it('keeps scanner fields only when strings and orders all severity states', () => {
        const scans = {
            invalid: null,
            unknown: { status: 'future', statusText: 123, reportUrl: false },
            benign: { status: 'BENIGN', statusText: 'clean', reportUrl: 'https://report.invalid' },
            scanning: { status: 'scanning' },
            suspicious: { status: 'suspicious' },
            malicious: { status: 'malicious' }
        };
        expect(mapSecurity(scans)).toEqual({
            worst: 'malicious',
            reports: {
                unknown: { status: 'unknown', statusText: undefined, reportUrl: undefined },
                benign: { status: 'benign', statusText: 'clean', reportUrl: 'https://report.invalid' },
                scanning: { status: 'scanning', statusText: undefined, reportUrl: undefined },
                suspicious: { status: 'suspicious', statusText: undefined, reportUrl: undefined },
                malicious: { status: 'malicious', statusText: undefined, reportUrl: undefined }
            }
        });
        expect(mapSecurity({ scanner: {} })?.worst).toBe('unknown');
        expect(mapSecurity({ benign: scans.benign, scanning: scans.scanning })?.worst).toBe('scanning');
    });

    it.each([null, undefined, false, 42, '', {}, { slug: ' ' }])('rejects card without slug %j', (input) => {
        expect(mapCard(input, new Set())).toBeNull();
    });

    it('maps all official card fields and canonical installed identity', () => {
        const raw = {
            slug: ' sample ',
            displayName: ' 中文展示 ',
            name: 'less preferred',
            description_zh: ' 中文简介 ',
            description: 'English description',
            category: 'dev-programming',
            namespace: { canonicalName: '@Team/Sample', handle: 'user_ab123' },
            latestVersion: { version: ' 2.0 ' },
            version: '1.0',
            stats: { downloads: '25', stars: '3', installs: 7 },
            downloads: 999,
            labels: { requires_api_key: true },
            iconUrl: 'https://image.invalid/icon',
            ownerName: 'real-owner',
            overviewMd: '# Overview',
            source: 'community',
            publisher: { verified: true, name: 'Publisher' },
            securityReports: { scanner: { status: 'benign' } }
        };
        expect(mapCard(raw, new Set(['@team/sample']))).toEqual({
            slug: 'sample',
            name: '中文展示',
            description: '中文简介',
            category: 'dev-programming',
            categoryLabel: '开发编程',
            version: '2.0',
            downloads: 25,
            stars: 3,
            installs: 7,
            requiresApiKey: true,
            iconUrl: 'https://image.invalid/icon',
            owner: 'real-owner',
            canonicalName: '@Team/Sample',
            overview: '# Overview',
            source: 'community',
            installed: true,
            pageUrl: 'https://skillhub.cn/skills/sample',
            verified: true,
            publisherName: 'Publisher',
            security: {
                worst: 'benign',
                reports: { scanner: { status: 'benign', statusText: undefined, reportUrl: undefined } }
            }
        });
        expect(mapCard(raw, new Set(['sample', '@other/sample']))?.installed).toBe(false);
    });

    it('falls back to namespace public slug, direct stats, summary and custom category', () => {
        expect(
            mapCard(
                {
                    namespace: { publicSlug: 'Some Slug', handle: ' owner ' },
                    name: ' Name ',
                    summary_zh: ' 摘要 ',
                    category: 'custom',
                    version: ' 0.1 ',
                    downloads: '9',
                    stars: Infinity,
                    installs: 'bad',
                    publisher: { verified: false, name: 'must not expose' }
                },
                new Set(['some slug'])
            )
        ).toMatchObject({
            slug: 'Some Slug',
            name: 'Name',
            description: '摘要',
            categoryLabel: 'custom',
            version: '0.1',
            downloads: 9,
            stars: 0,
            installs: 0,
            owner: 'owner',
            requiresApiKey: false,
            installed: true,
            pageUrl: 'https://skillhub.cn/skills/Some%20Slug'
        });
        const minimal = mapCard({ slug: 'bare' }, new Set());
        expect(minimal).toEqual({
            slug: 'bare',
            name: 'bare',
            description: '',
            category: '',
            categoryLabel: '',
            version: '',
            downloads: 0,
            stars: 0,
            installs: 0,
            requiresApiKey: false,
            iconUrl: undefined,
            owner: undefined,
            canonicalName: undefined,
            overview: undefined,
            source: undefined,
            installed: false,
            pageUrl: 'https://skillhub.cn/skills/bare'
        });
        expect(mapCard({ slug: 'bare', summary: ' fallback ' }, new Set())?.description).toBe('fallback');
        expect(mapCard({ slug: 'bare', description: ' direct ', summary: 'ignored' }, new Set())?.description).toBe(
            'direct'
        );
    });

    it.each(['user_abc123', 'u_abc123', 'org-abc123', 'org_abc123'])('hides generated owner %s', (owner) => {
        expect(
            mapCard({ slug: 'sample', namespace: { handle: owner }, ownerName: owner }, new Set())?.owner
        ).toBeUndefined();
    });

    it('uses real owner display name before handle and does not require verified publisher name', () => {
        const card = mapCard(
            {
                slug: 'sample',
                ownerDisplayName: ' 中文作者 ',
                namespace: { handle: 'real-handle' },
                publisher: { verified: true }
            },
            new Set()
        );
        expect(card?.owner).toBe('中文作者');
        expect(card?.verified).toBe(true);
        expect(card).not.toHaveProperty('publisherName');
    });
});

describe('SkillHub search, detail and version DTOs', () => {
    const options = { query: 'query', category: 'education', limit: 12, offset: 2, installed: new Set(['@a/same']) };

    it('deduplicates canonical identities case-insensitively but keeps different namespaces', () => {
        const result = mapSearch(
            {
                data: {
                    total: '12',
                    skills: [
                        null,
                        {},
                        { slug: 'same', namespace: { canonicalName: '@a/same' } },
                        { slug: 'same', namespace: { canonicalName: '@A/SAME' } },
                        { slug: 'same', namespace: { canonicalName: '@b/same' } },
                        { slug: 'bare' },
                        { slug: 'BARE' }
                    ]
                }
            },
            options
        );
        expect(result).toMatchObject({ query: 'query', category: 'education', total: 12, offset: 2, hasMore: true });
        expect(result.items.map((item) => [item.canonicalName || item.slug, item.installed])).toEqual([
            ['@a/same', true],
            ['@b/same', false],
            ['bare', false]
        ]);
    });

    it('accepts unwrapped items and stops paging when total missing or list empty', () => {
        expect(mapSearch({ items: [{ slug: 'one' }] }, options)).toMatchObject({ total: 3, hasMore: false });
        expect(mapSearch({ total: 100, skills: [] }, options)).toMatchObject({ items: [], total: 100, hasMore: false });
        expect(mapSearch(null, options)).toMatchObject({ items: [], total: 2, hasMore: false });
        expect(mapSearch({ data: { skills: false, items: false } }, options).items).toEqual([]);
    });

    it('merges detail-level namespace, publisher/version/security/owner ahead of skill defaults', () => {
        const detail = {
            data: {
                slug: 'detail',
                skill: {
                    slug: 'nested',
                    ownerName: 'nested-author',
                    latestVersion: { version: 'old' },
                    namespace: { canonicalName: '@old/detail' }
                },
                namespace: { canonicalName: '@new/detail', handle: 'user_123' },
                latestVersion: { version: 'new' },
                securityReports: { scanner: { status: 'suspicious' } },
                publisher: { verified: true, name: 'Company' },
                owner: { displayName: '作者昵称', handle: 'auto-handle' }
            }
        };
        expect(mapDetailCard(detail, new Set(['@new/detail']))).toMatchObject({
            slug: 'detail',
            canonicalName: '@new/detail',
            version: 'new',
            owner: '作者昵称',
            publisherName: 'Company',
            installed: true,
            security: { worst: 'suspicious' }
        });
        expect(mapDetail(detail, { versions: [{ version: '1.0' }] }, new Set())?.versions).toEqual([
            { version: '1.0' }
        ]);
    });

    it('uses nested skill fields, owner handle, and returns null when no slug is available', () => {
        expect(mapDetailCard({ skill: { slug: 'nested', ownerName: 'nested-owner' } }, new Set())).toMatchObject({
            slug: 'nested',
            owner: 'nested-owner'
        });
        expect(mapDetailCard({ skill: { slug: 'nested' }, owner: { handle: 'real-handle' } }, new Set())?.owner).toBe(
            'real-handle'
        );
        expect(mapDetailCard(undefined, new Set())).toBeNull();
        expect(mapDetail(null, null, new Set())).toBeNull();
    });

    it('filters invalid versions and maps optional numeric timestamps, changelogs and security', () => {
        expect(
            mapVersions({
                data: {
                    versions: [
                        null,
                        false,
                        '1.0',
                        {},
                        { version: ' ' },
                        {
                            version: ' 1.0 ',
                            changelog: 'changes',
                            createdAt: '1234',
                            securityReports: { scan: { status: 'malicious' } }
                        },
                        { version: '2.0', createdAt: 'not-time', changelog: '' },
                        { version: '3.0' }
                    ]
                }
            })
        ).toEqual([
            {
                version: '1.0',
                changelog: 'changes',
                createdAt: 1234,
                security: {
                    worst: 'malicious',
                    reports: { scan: { status: 'malicious', statusText: undefined, reportUrl: undefined } }
                }
            },
            { version: '2.0' },
            { version: '3.0' }
        ]);
        expect(mapVersions({ versions: [{ version: '4.0' }] })).toEqual([{ version: '4.0' }]);
        expect(mapVersions(undefined)).toEqual([]);
        expect(mapVersions({ versions: 'invalid' })).toEqual([]);
    });
});

describe('SkillHub local identity and SKILL.md normalization', () => {
    it.each([
        ['@Team_Name/Skill_Name', 'unused', 'team-name-skill-name'],
        ['@123/456', 'unused', 'sh-123-456'],
        ['@org--team/my--skill', 'unused', 'org-team-my-skill'],
        [' @team_/skill_ ', 'unused', 'team-skill'],
        [undefined, ' Good-Skill ', 'good-skill'],
        ['invalid/canonical', 'fallback', 'fallback']
    ])('derives a local identity for %j', (canonical, slug, id) => {
        expect(skillHubLocalId(canonical, slug)).toBe(id);
    });

    it.each(['', '../escape', 'bad_slug', '123', '-first', 'bad space'])('rejects unsupported bare ID %j', (id) => {
        expect(() => normalizeSkillHubId(id)).toThrow('不符合命名规则');
    });

    it('preserves body, source attribution, triggers and quoted YAML values through serialization', () => {
        const normalized = normalizeSkillHubSkillMd(
            skillMd(
                [
                    'slug: Sample',
                    'description: "描述: 含冒号, 逗号"',
                    'version: 1.2.3',
                    'author: Alice',
                    'license: MIT',
                    'displayName: " 包内展示名 "',
                    'triggers: [keyword, 123, second]',
                    'metadata:',
                    '  display_name: lower-priority'
                ].join('\n')
            ),
            { canonicalName: ' @Team/Sample ', displayName: '市场名' }
        );
        expect(frontmatter(normalized)).toEqual({
            name: 'team-sample',
            description: '描述: 含冒号, 逗号',
            license: 'Internal',
            compatibility: 'zhuixun 2.x',
            triggers: ['keyword', 'second'],
            metadata: { display_name: '包内展示名', source_canonical: '@Team/Sample' }
        });
        expect(normalized).toContain(
            '<!-- source: SkillHub | source_slug: Sample | source_version: 1.2.3 | source_author: Alice | source_license: MIT -->'
        );
        expect(normalized).toContain('# Body\n\nKeep [reference](references/guide.md).');
        expect(frontmatter(normalized)).not.toHaveProperty('version');
    });

    it.each([
        [
            'slug: sample\nmetadata:\n  display_name: " 元数据展示名 "',
            { canonicalName: '@team/sample', displayName: '市场名' },
            '元数据展示名'
        ],
        ['name: sample', { canonicalName: '@team/sample', displayName: ' 市场名 ' }, '市场名'],
        ['slug: sample', { canonicalName: '@team/sample' }, 'sample'],
        ['slug: sample', { displayName: 'sample' }, undefined],
        ['name: sample', {}, undefined]
    ])('selects display name priority %#', (fields, opts, expected) => {
        const fm = frontmatter(normalizeSkillHubSkillMd(skillMd(fields), opts));
        expect((fm.metadata as Record<string, string> | undefined)?.display_name).toBe(expected);
    });

    it('can use canonical id when source name/slug are absent without inventing provenance', () => {
        const normalized = normalizeSkillHubSkillMd(skillMd('description: From canonical'), {
            canonicalName: '@team/sample'
        });
        expect(frontmatter(normalized)).toEqual({
            name: 'team-sample',
            description: 'From canonical',
            license: 'Internal',
            compatibility: 'zhuixun 2.x',
            metadata: { source_canonical: '@team/sample' }
        });
        expect(normalized).not.toContain('<!--');
    });

    it('accepts BOM/CRLF but rejects malformed frontmatter and invalid bare IDs', () => {
        const normalized = normalizeSkillHubSkillMd('﻿' + skillMd('name: Sample').replace(/\n/g, '\r\n'));
        expect(frontmatter(normalized).name).toBe('sample');
        expect(() => normalizeSkillHubSkillMd('body only')).toThrow('missing frontmatter');
        expect(() => normalizeSkillHubSkillMd(skillMd('slug: bad_slug'))).toThrow('不符合命名规则');
    });
});
