import { describe, expect, it } from 'vitest';

import {
    mapCard,
    mapSecurity,
    mapSearch,
    normalizeSkillHubId,
    skillHubLocalId
} from '@/modules/skills/skillhub/mapper';

describe('SkillHub mapper', () => {
    it('selects the most severe security report', () => {
        expect(
            mapSecurity({
                keen: { status: 'benign' },
                sanbu: { status: 'suspicious', reportUrl: 'https://example.com/report' },
                unknown: { status: 'other' }
            })
        ).toEqual({
            worst: 'suspicious',
            reports: {
                keen: { status: 'benign', statusText: undefined, reportUrl: undefined },
                sanbu: { status: 'suspicious', statusText: undefined, reportUrl: 'https://example.com/report' },
                unknown: { status: 'unknown', statusText: undefined, reportUrl: undefined }
            }
        });
    });

    it('uses canonical namespace identity for local IDs and installation state', () => {
        expect(skillHubLocalId('@Team_Name/dev-expert', 'dev-expert')).toBe('team-name-dev-expert');
        expect(
            mapCard(
                {
                    slug: 'dev-expert',
                    namespace: { canonicalName: '@team_name/dev-expert' },
                    displayName: '开发专家',
                    category: 'dev-programming',
                    latestVersion: { version: '1.0.0' }
                },
                new Set(['team-name-dev-expert'])
            )?.installed
        ).toBe(false);
    });

    it('maps search results and removes duplicate canonical entries', () => {
        const result = mapSearch(
            {
                data: {
                    total: 3,
                    skills: [
                        { slug: 'one', namespace: { canonicalName: '@a/one' } },
                        { slug: 'one', namespace: { canonicalName: '@a/one' } },
                        { slug: 'two', namespace: { canonicalName: '@a/two' } }
                    ]
                }
            },
            { query: 'x', limit: 10, offset: 0, installed: new Set() }
        );
        expect(result.items).toHaveLength(2);
        expect(result.hasMore).toBe(true);
    });

    it('rejects unsafe SkillHub IDs', () => {
        expect(normalizeSkillHubId('Good-Skill')).toBe('good-skill');
        expect(() => normalizeSkillHubId('../escape')).toThrow();
        expect(() => normalizeSkillHubId('_bad')).toThrow();
    });
});
