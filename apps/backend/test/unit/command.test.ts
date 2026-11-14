import { describe, expect, it } from 'vitest';

import { deriveCommandHead, matchesCommandScope } from '@/platform/command';

describe('command head parsing', () => {
    it('parses a safe command and skips environment assignments', () => {
        expect(deriveCommandHead('FOO=bar git status --short')).toEqual({ safe: true, head: 'git status' });
    });

    it('limits the remembered head to the first two subcommands', () => {
        expect(deriveCommandHead('npm run build production')).toEqual({ safe: true, head: 'npm run build' });
    });

    it('rejects shell composition and quoting', () => {
        expect(deriveCommandHead('git status && rm -rf .')).toEqual({ safe: false, reason: 'compound' });
        expect(deriveCommandHead('git "status"')).toEqual({ safe: false, reason: 'unsafe' });
    });

    it('keeps dangerous commands out of remembered approvals', () => {
        expect(deriveCommandHead('/bin/rm -rf cache')).toEqual({ safe: false, head: '/bin/rm', reason: 'denylisted' });
    });

    it('matches normalized command scopes only for trusted heads', () => {
        expect(matchesCommandScope('git log --oneline', 'git log:*')).toBe(true);
        expect(matchesCommandScope('git status', 'git:*')).toBe(true);
        expect(matchesCommandScope('git status && rm -rf .', 'git:*')).toBe(false);
        expect(matchesCommandScope('npm run build', 'npm test')).toBe(false);
    });
});
