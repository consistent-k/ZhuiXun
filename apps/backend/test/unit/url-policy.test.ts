import { describe, expect, it } from 'vitest';

import { WebAccessError, matchesHost, parseAndValidateUrl } from '@/platform/web/url-policy';

describe('web URL policy', () => {
    it('matches exact hosts and wildcard subdomains', () => {
        expect(matchesHost('example.com', 'example.com')).toBe(true);
        expect(matchesHost('api.example.com', '*.example.com')).toBe(true);
        expect(matchesHost('other.test', '*.example.com')).toBe(false);
    });

    it('accepts public HTTP URLs on standard ports', () => {
        const url = parseAndValidateUrl('https://example.com/path?q=1', { allowedHosts: [], blockedHosts: [] });
        expect(url.href).toBe('https://example.com/path?q=1');
    });

    it('rejects unsupported ports and credentials', () => {
        expect(() => parseAndValidateUrl('https://example.com:8443', { allowedHosts: [], blockedHosts: [] })).toThrow(
            WebAccessError
        );
        expect(() =>
            parseAndValidateUrl('https://user:pass@example.com', { allowedHosts: [], blockedHosts: [] })
        ).toThrow(WebAccessError);
    });

    it('rejects local and metadata hosts before network access', () => {
        for (const raw of ['http://localhost', 'http://127.0.0.1', 'http://metadata.google.internal']) {
            expect(() => parseAndValidateUrl(raw, { allowedHosts: [], blockedHosts: [] })).toThrow(
                expect.objectContaining({ code: 'BLOCKED_HOST' })
            );
        }
    });

    it('applies blocked hosts before the allow list', () => {
        expect(() =>
            parseAndValidateUrl('https://api.example.com', {
                allowedHosts: ['*.example.com'],
                blockedHosts: ['api.example.com']
            })
        ).toThrow(expect.objectContaining({ code: 'BLOCKED_HOST' }));
    });
});
