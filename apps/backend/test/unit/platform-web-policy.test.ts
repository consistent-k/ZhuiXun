import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    matchesHost,
    parseAndValidateUrl,
    resolvePublicAddress,
    WebAccessError,
    type HostPolicy
} from '@/platform/web/url-policy';

// setup 已阻断真实 DNS；每个用例只覆盖 lookup 的受控返回，不 mock 被测模块。
const policy: HostPolicy = { allowedHosts: [], blockedHosts: [] };
const dns = vi.mocked(lookup as (host: string, options: LookupAllOptions) => Promise<LookupAddress[]>);

beforeEach(() => {
    dns.mockReset();
    dns.mockRejectedValue(new Error('unexpected DNS lookup'));
});

describe('Web host rules and URL validation', () => {
    it.each([
        ['example.com', '  .EXAMPLE.COM... ', true],
        ['example.com', '*.example.com', true],
        ['api.deep.example.com', '*.example.com', true],
        ['badexample.com', '*.example.com', false],
        ['example.com.evil.test', '*.example.com', false],
        ['any.test', '*', true],
        ['example.com', ' ... ', false],
        ['api.example.com', 'example.com', false]
    ])('matches %s against %s as %s', (host, pattern, expected) => {
        expect(matchesHost(host, pattern)).toBe(expected);
    });

    it.each([
        ['  HTTPS://EXAMPLE.COM.../path?q=1#part  ', 'https://example.com/path?q=1#part'],
        ['http://example.com:80', 'http://example.com/'],
        ['https://example.com:443', 'https://example.com/'],
        ['http://example.com:443', 'http://example.com:443/'],
        ['https://example.com:80', 'https://example.com:80/'],
        ['https://[2606:4700:4700::1111]/', 'https://[2606:4700:4700::1111]/'],
        ['http://8.8.8.8', 'http://8.8.8.8/']
    ])('normalizes allowed public URL %s', (raw, expected) => {
        expect(parseAndValidateUrl(raw, policy).href).toBe(expected);
        expect(dns).not.toHaveBeenCalled();
    });

    it.each([
        '',
        '   ',
        'not a URL',
        'https://',
        'https://[invalid-ip]',
        'file:///tmp/test',
        'ftp://example.com',
        'data:text/plain,hello',
        'https://user@example.com',
        'https://:password@example.com',
        'http://example.com:8080',
        'http://example.com:0'
    ])('rejects malformed/unsupported/credential-bearing URL %j before DNS', (raw) => {
        expect(() => parseAndValidateUrl(raw, policy)).toThrow(
            expect.objectContaining({ name: 'WebAccessError', code: 'INVALID_URL' })
        );
        expect(dns).not.toHaveBeenCalled();
    });

    it.each([
        'localhost',
        'LOCALHOST.',
        'sub.localhost',
        'router.local',
        'service.internal',
        'device.home.arpa',
        'metadata',
        'metadata.google.internal',
        'instance-data',
        'instance-data.ec2.internal',
        '127.1',
        '2130706433',
        '0x7f000001',
        '[::1]',
        '[::ffff:127.0.0.1]'
    ])('rejects local and metadata host %s even with wildcard permission', (host) => {
        expect(() => parseAndValidateUrl(`http://${host}`, { ...policy, allowedHosts: ['*'] })).toThrow(
            expect.objectContaining({ code: 'BLOCKED_HOST' })
        );
        expect(dns).not.toHaveBeenCalled();
    });

    it('normalizes the URL host before rules and gives the deny list priority', () => {
        expect(
            parseAndValidateUrl('https://API.EXAMPLE.COM./', {
                allowedHosts: ['*.example.com'],
                blockedHosts: ['unrelated.test']
            }).hostname
        ).toBe('api.example.com');
        expect(() =>
            parseAndValidateUrl('https://api.example.com', {
                allowedHosts: ['*.example.com'],
                blockedHosts: ['*.example.com']
            })
        ).toThrow(expect.objectContaining({ code: 'BLOCKED_HOST', message: expect.stringContaining('禁止列表') }));
        expect(() =>
            parseAndValidateUrl('https://example.com.evil.test', { ...policy, allowedHosts: ['*.example.com'] })
        ).toThrow(expect.objectContaining({ code: 'BLOCKED_HOST', message: expect.stringContaining('允许列表') }));
    });

    it('preserves the structured HTTP error status', () => {
        const error = new WebAccessError('HTTP_ERROR', 'upstream rejected', 503);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ name: 'WebAccessError', code: 'HTTP_ERROR', status: 503 });
    });
});

describe('public address resolution and pinning', () => {
    it.each([
        '0.0.0.0',
        '10.255.255.255',
        '127.255.255.255',
        '100.64.0.0',
        '100.127.255.255',
        '169.254.169.254',
        '172.16.0.0',
        '172.31.255.255',
        '192.168.255.255',
        '192.0.0.1',
        '192.0.2.1',
        '198.18.0.0',
        '198.19.255.255',
        '198.51.100.1',
        '203.0.113.1',
        '224.0.0.0',
        '239.255.255.255',
        '240.0.0.1',
        '255.255.255.255',
        '::',
        '::1',
        '::2',
        'fc00::1',
        'fdff::1',
        'fe80::1',
        'fe90::1',
        'fea0::1',
        'febf::1',
        'ff02::1',
        '2001:db8::1',
        '::ffff:10.0.0.1',
        '::ffff:7f00:1',
        '64:ff9b::192.168.1.1',
        '64:ff9b::a00:1',
        '::127.0.0.1',
        '::7f00:1'
    ])('blocks non-public IP literal %s without DNS', async (address) => {
        await expect(resolvePublicAddress(address)).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
        expect(dns).not.toHaveBeenCalled();
    });

    it.each([
        '100.63.255.255',
        '100.128.0.0',
        '169.253.255.255',
        '172.15.255.255',
        '172.32.0.0',
        '192.0.1.1',
        '198.17.255.255',
        '198.20.0.0',
        '198.51.99.255',
        '203.0.112.255',
        '223.255.255.255'
    ])('allows public IPv4 at reserved-range boundary %s', async (address) => {
        await expect(resolvePublicAddress(address)).resolves.toEqual({ address, family: 4 });
        expect(dns).not.toHaveBeenCalled();
    });

    it.each([
        ['[2606:4700:4700::1111]', '2606:4700:4700::1111'],
        ['2606:4700:4700::1111', '2606:4700:4700::1111'],
        ['::ffff:8.8.8.8', '::ffff:8.8.8.8'],
        ['::ffff:808:808', '::ffff:808:808'],
        ['64:ff9b::8.8.8.8', '64:ff9b::8.8.8.8'],
        ['64:ff9b::808:808', '64:ff9b::808:808'],
        ['::8.8.8.8', '::8.8.8.8'],
        ['::808:808', '::808:808']
    ])('pins public IPv6 %s without a DNS round trip', async (host, address) => {
        await expect(resolvePublicAddress(host)).resolves.toEqual({ address, family: 6 });
        expect(dns).not.toHaveBeenCalled();
    });

    it('looks up all records verbatim once and returns the first approved address', async () => {
        dns.mockResolvedValue([
            { address: '2606:4700:4700::1111', family: 6 },
            { address: '8.8.8.8', family: 4 }
        ]);
        await expect(resolvePublicAddress('public.example')).resolves.toEqual({
            address: '2606:4700:4700::1111',
            family: 6
        });
        expect(dns).toHaveBeenCalledExactlyOnceWith('public.example', { all: true, order: 'verbatim' });
    });

    it('returns an IPv4 pin without trusting an unchecked second DNS answer', async () => {
        dns.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
        dns.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
        await expect(resolvePublicAddress('rebind.example')).resolves.toEqual({ address: '8.8.8.8', family: 4 });
        expect(dns).toHaveBeenCalledTimes(1);
        await expect(resolvePublicAddress('rebind.example')).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
    });

    it.each([
        [
            { address: '8.8.8.8', family: 4 },
            { address: '127.0.0.1', family: 4 }
        ],
        [
            { address: '10.0.0.1', family: 4 },
            { address: '2606:4700:4700::1111', family: 6 }
        ],
        [
            { address: '8.8.8.8', family: 4 },
            { address: '::ffff:a00:1', family: 6 }
        ],
        [{ address: 'invalid-address', family: 4 }]
    ])('rejects the entire DNS answer if any record is unsafe: %j', async (...records) => {
        dns.mockResolvedValue(records);
        await expect(resolvePublicAddress('mixed.example')).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
    });

    it.each(['NXDOMAIN', 'EAI_AGAIN'])('turns lookup error %s into a controlled DNS failure', async (code) => {
        dns.mockRejectedValue(Object.assign(new Error('resolver details'), { code }));
        await expect(resolvePublicAddress('missing.example')).rejects.toMatchObject({
            name: 'WebAccessError',
            code: 'DNS_FAILED',
            message: '域名解析失败：missing.example'
        });
    });

    it('rejects an empty DNS answer', async () => {
        dns.mockResolvedValue([]);
        await expect(resolvePublicAddress('empty.example')).rejects.toMatchObject({
            code: 'DNS_FAILED',
            message: '域名没有可用地址：empty.example'
        });
    });
});
