import { describe, expect, it } from 'vitest';

import { isValidSkillId, resolveUserSkillDir } from '@/modules/skills/store';

describe('skills store identifiers', () => {
    it.each(['a', 'workspace-review', 'skill-2', 'a--b', 'a-'])('accepts supported id %s', (id) => {
        expect(isValidSkillId(id)).toBe(true);
        expect(resolveUserSkillDir('/sandbox/skills', id)).toBe(`/sandbox/skills/${id}`);
    });

    it.each(['', '../escape', '..', '/absolute', 'a/b', 'a\\b', 'Upper', '0first', '_private', 'a.b', 'a\0b'])(
        'rejects unsafe id %s before resolving a filesystem destination',
        (id) => {
            expect(isValidSkillId(id)).toBe(false);
            expect(() => resolveUserSkillDir('/sandbox/skills', id)).toThrow('非法技能 id');
        }
    );

    it('normalizes a relative base while keeping the id as its direct child', () => {
        expect(resolveUserSkillDir('/sandbox/skills/../user', 'sample')).toBe('/sandbox/user/sample');
    });
});
