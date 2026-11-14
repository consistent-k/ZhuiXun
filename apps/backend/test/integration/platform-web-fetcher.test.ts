import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import { requestUrl, type FetchPolicy } from '@/platform/web/fetcher';
import { fetchReadablePage } from '@/platform/web/index';
import { WebAccessError } from '@/platform/web/url-policy';

interface Reply {
    status?: number;
    statusText?: string;
    headers?: Record<string, string | string[] | undefined>;
    chunks?: Buffer[];
    body?: Buffer;
    error?: unknown;
    requestError?: unknown;
    noStatus?: boolean;
    hold?: boolean;
    lateEvents?: boolean;
}

class FakeResponse extends EventEmitter {
    statusCode: number | undefined;
    statusMessage: string | undefined;
    headers: http.IncomingHttpHeaders;
    resume = vi.fn();
    destroy = vi.fn();

    constructor(reply: Reply) {
        super();
        this.statusCode = reply.noStatus ? undefined : (reply.status ?? 200);
        this.statusMessage = reply.noStatus ? undefined : (reply.statusText ?? 'OK');
        this.headers = (reply.headers ?? { 'content-type': 'text/plain' }) as http.IncomingHttpHeaders;
    }
}

class FakeRequest extends EventEmitter {
    readonly reply: Reply;
    response?: FakeResponse;
    destroy = vi.fn((error?: Error) => {
        if (error) this.emit('error', error);
        return this;
    });
    end = vi.fn(() => {
        if (!this.reply.hold) queueMicrotask(() => this.deliver());
        return this;
    });

    constructor(
        readonly url: URL,
        readonly options: http.RequestOptions,
        readonly callback: (response: http.IncomingMessage) => void,
        reply: Reply
    ) {
        super();
        this.reply = reply;
    }

    deliver(): void {
        if (this.reply.requestError) {
            this.emit('error', this.reply.requestError);
            return;
        }
        const response = new FakeResponse(this.reply);
        this.response = response;
        this.callback(response as unknown as http.IncomingMessage);
        if (this.reply.error) {
            response.emit('error', this.reply.error);
        } else {
            for (const chunk of this.reply.chunks ?? [this.reply.body ?? Buffer.from('hello')]) {
                response.emit('data', chunk);
            }
            response.emit('end');
        }
        if (this.reply.lateEvents) {
            response.emit('end');
            this.emit('error', new Error('late error'));
        }
    }
}

const policy: FetchPolicy = { allowedHosts: [], blockedHosts: [], timeoutMs: 500, maxBytes: 1024 };
let replies: Reply[];
let requests: FakeRequest[];

async function settleMicrotasks(): Promise<void> {
    for (let i = 0; i < 15; i++) await Promise.resolve();
}

beforeEach(() => {
    replies = [];
    requests = [];
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    const fake = (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
        const reply = replies.shift();
        if (!reply) throw new Error('未提供 fake response，禁止真实 HTTP');
        const request = new FakeRequest(url, options, callback, reply);
        requests.push(request);
        return request as unknown as http.ClientRequest;
    };
    vi.spyOn(http, 'request').mockImplementation(fake as typeof http.request);
    vi.spyOn(https, 'request').mockImplementation(fake as typeof https.request);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('platform web fetcher: raw transport and pinned addresses', () => {
    it('uses GET over HTTPS with original host and DNS-pinned lookup in both Node callback shapes', async () => {
        replies.push({ headers: { 'content-type': [' Text/Plain ; charset="UTF-8"; other=x'] } });
        const response = await requestUrl('https://public.example/a?q=1', policy);
        expect(response).toMatchObject({
            status: 200,
            statusText: 'OK',
            mime: 'text/plain',
            charset: 'UTF-8',
            finalUrl: 'https://public.example/a?q=1',
            bytesRead: 5
        });
        expect(response.body.toString()).toBe('hello');
        expect(dns.lookup).toHaveBeenCalledWith('public.example', { all: true, order: 'verbatim' });
        expect(https.request).toHaveBeenCalledOnce();
        expect(http.request).not.toHaveBeenCalled();
        const { url, options } = requests[0];
        expect(url.hostname).toBe('public.example');
        expect(options).toMatchObject({ method: 'GET', headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
        const callback = vi.fn();
        const lookup = options.lookup as unknown as (
            hostname: string,
            options: { all?: boolean },
            cb: typeof callback
        ) => void;
        lookup('should-not-resolve.example', {}, callback);
        expect(callback).toHaveBeenLastCalledWith(null, '8.8.8.8', 4);
        lookup('should-not-resolve.example', { all: true }, callback);
        expect(callback).toHaveBeenLastCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
        expect(dns.lookup).toHaveBeenCalledOnce();
    });

    it('uses HTTP and public literal IPv6 without DNS lookup', async () => {
        replies.push({ headers: {} });
        const response = await requestUrl('http://[2606:4700:4700::1111]/', policy);
        expect(response.mime).toBe('');
        expect(http.request).toHaveBeenCalledOnce();
        expect(dns.lookup).not.toHaveBeenCalled();
        const callback = vi.fn();
        const lookup = requests[0].options.lookup as unknown as (
            hostname: string,
            options: object,
            cb: typeof callback
        ) => void;
        lookup('ignored', {}, callback);
        expect(callback).toHaveBeenCalledWith(null, '2606:4700:4700::1111', 6);
    });

    it.each(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json'])(
        'accepts %s',
        async (mime) => {
            replies.push({ headers: { 'content-type': mime } });
            expect((await requestUrl('http://public.example', policy)).mime).toBe(mime);
        }
    );

    it('rejects unsupported MIME and preserves empty charset as undefined', async () => {
        replies.push({ headers: { 'content-type': 'image/png; charset=""' } });
        await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({
            code: 'UNSUPPORTED_CONTENT_TYPE'
        });
        replies.push({ headers: { 'content-type': 'text/plain; charset=""' } });
        expect((await requestUrl('http://public.example', policy)).charset).toBeUndefined();
    });

    it('concatenates chunks and settles only once despite duplicate end/request error', async () => {
        replies.push({ chunks: [Buffer.from('a'), Buffer.from('中文')], lateEvents: true });
        const response = await requestUrl('http://public.example', policy);
        expect(response.body.toString()).toBe('a中文');
        expect(response.bytesRead).toBe(7);
    });
});

describe('platform web fetcher: redirect security at every hop', () => {
    it('resolves and pins each relative/absolute redirect independently', async () => {
        vi.mocked(dns.lookup)
            .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
            .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }] as never)
            .mockResolvedValueOnce([{ address: '2606:4700::1111', family: 6 }] as never);
        replies.push(
            { status: 301, headers: { location: '/second' } },
            { status: 307, headers: { location: ['https://next.example/final'] } },
            { body: Buffer.from('done') }
        );
        const response = await requestUrl('http://public.example/start', policy);
        expect(response.finalUrl).toBe('https://next.example/final');
        expect(requests.map((request) => request.url.href)).toEqual([
            'http://public.example/start',
            'http://public.example/second',
            'https://next.example/final'
        ]);
        expect(vi.mocked(dns.lookup).mock.calls.map(([host]) => host)).toEqual([
            'public.example',
            'public.example',
            'next.example'
        ]);
        for (const [i, address] of ['8.8.8.8', '1.1.1.1', '2606:4700::1111'].entries()) {
            const callback = vi.fn();
            const lookup = requests[i].options.lookup as unknown as (
                hostname: string,
                options: object,
                cb: typeof callback
            ) => void;
            lookup('ignored', {}, callback);
            expect(callback).toHaveBeenCalledWith(null, address, i === 2 ? 6 : 4);
        }
        expect(requests[0].response?.resume).toHaveBeenCalledOnce();
    });

    it.each([
        'http://127.0.0.1/',
        'http://[::ffff:7f00:1]/',
        'http://metadata.google.internal/',
        'ftp://public.example/',
        'http://public.example:8080/',
        'http://user:pass@public.example/'
    ])('rejects unsafe redirect %s before next transport', async (location) => {
        replies.push({ status: 302, headers: { location } });
        await expect(requestUrl('https://public.example', policy)).rejects.toBeInstanceOf(WebAccessError);
        expect(requests).toHaveLength(1);
    });

    it('enforces allow/block lists again on redirect', async () => {
        replies.push({ status: 303, headers: { location: 'https://next.example' } });
        await expect(
            requestUrl('https://public.example', { ...policy, allowedHosts: ['public.example'] })
        ).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
        replies.push({ status: 308, headers: { location: 'https://next.example' } });
        await expect(
            requestUrl('https://public.example', { ...policy, blockedHosts: ['next.example'] })
        ).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
        expect(requests).toHaveLength(2);
    });

    it('blocks DNS rebinding on a later hop including mixed public/private answers', async () => {
        vi.mocked(dns.lookup)
            .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
            .mockResolvedValueOnce([
                { address: '8.8.8.8', family: 4 },
                { address: '10.0.0.1', family: 4 }
            ] as never);
        replies.push({ status: 302, headers: { location: '/rebind' } });
        await expect(requestUrl('https://public.example', policy)).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
        expect(requests).toHaveLength(1);
    });

    it('requires Location and caps the chain at six transport requests', async () => {
        replies.push({ status: 302, headers: {} });
        await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({
            code: 'HTTP_ERROR',
            status: 302
        });
        requests = [];
        replies.push(...Array.from({ length: 6 }, () => ({ status: 308, headers: { location: '/again' } })));
        await expect(requestUrl('https://public.example', policy)).rejects.toMatchObject({
            code: 'HTTP_ERROR',
            status: 308,
            message: expect.stringContaining('5')
        });
        expect(requests).toHaveLength(6);
    });

    it.each([{ status: 404, statusText: 'Not Found' }, { status: 500, statusText: '' }, { noStatus: true }])(
        'maps non-2xx to stable HTTP_ERROR ($status)',
        async (reply) => {
            replies.push(reply);
            await expect(requestUrl('https://public.example', policy)).rejects.toMatchObject({
                code: 'HTTP_ERROR',
                status: reply.noStatus ? 0 : reply.status
            });
            expect(requests[0].response?.resume).toHaveBeenCalledOnce();
        }
    );
});

const compressionCases = [
    ['gzip', gzipSync],
    ['x-gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync]
] as const;

describe('platform web fetcher: compression and byte ceilings', () => {
    it.each(compressionCases)('decompresses %s and counts decoded bytes', async (encoding, compress) => {
        const body = Buffer.from('中文内容'.repeat(10));
        replies.push({
            body: compress(body),
            headers: { 'content-encoding': [encoding], 'content-type': 'text/plain' }
        });
        const response = await requestUrl('http://public.example', policy);
        expect(response.body).toEqual(body);
        expect(response.bytesRead).toBe(body.length);
    });

    it.each(['identity', 'unknown', ''])('passes through %s content encoding', async (encoding) => {
        replies.push({ headers: { 'content-encoding': encoding } });
        expect((await requestUrl('http://public.example', policy)).body.toString()).toBe('hello');
    });

    it.each(compressionCases)('rejects malformed %s with a stable error instead of raw bytes', async (encoding) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        replies.push({ headers: { 'content-encoding': encoding }, body: Buffer.from('not compressed') });
        await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({
            name: 'WebAccessError',
            code: 'NETWORK_ERROR',
            message: '响应解压失败'
        });
        expect(requests).toHaveLength(1);
    });

    it.each(compressionCases)('rejects empty and truncated %s without retrying', async (encoding, compress) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const compressed = compress(Buffer.from('中文正文'.repeat(10)));
        for (const body of [Buffer.alloc(0), compressed.subarray(0, Math.floor(compressed.length / 2))]) {
            replies.push({ headers: { 'content-encoding': encoding }, body });
            await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({
                code: 'NETWORK_ERROR',
                message: '响应解压失败'
            });
        }
        expect(requests).toHaveLength(2);
    });

    it('rejects a declared compressed length beyond 4x cap before reading data', async () => {
        replies.push({ headers: { 'content-length': '41' } });
        await expect(requestUrl('http://public.example', { ...policy, maxBytes: 10 })).rejects.toMatchObject({
            code: 'TOO_LARGE'
        });
        expect(requests[0].response?.destroy).toHaveBeenCalledOnce();
    });

    it('enforces streaming raw cap without trusting Content-Length', async () => {
        replies.push({ headers: { 'content-length': 'NaN' }, chunks: [Buffer.alloc(20), Buffer.alloc(21)] });
        await expect(requestUrl('http://public.example', { ...policy, maxBytes: 10 })).rejects.toMatchObject({
            code: 'TOO_LARGE'
        });
        expect(requests[0].response?.destroy).toHaveBeenCalledOnce();
    });

    it.each(['identity', 'unknown', ''])(
        'rejects %s decoded bytes above max, accepting the exact limit',
        async (encoding) => {
            const headers = { 'content-encoding': encoding };
            replies.push({ headers, body: Buffer.alloc(11) }, { headers, body: Buffer.alloc(10) });
            await expect(requestUrl('http://public.example', { ...policy, maxBytes: 10 })).rejects.toMatchObject({
                code: 'TOO_LARGE'
            });
            expect((await requestUrl('http://public.example', { ...policy, maxBytes: 10 })).bytesRead).toBe(10);
        }
    );

    it.each(compressionCases)('enforces the exact %s decompressed byte limit', async (encoding, compress) => {
        const body = Buffer.alloc(policy.maxBytes, 'a');
        const headers = { 'content-encoding': encoding, 'content-type': 'text/plain' };
        replies.push({ headers, body: compress(body) });
        const response = await requestUrl('http://public.example', policy);
        expect(response.body).toEqual(body);
        expect(response.bytesRead).toBe(policy.maxBytes);

        replies.push({ headers, body: compress(Buffer.alloc(policy.maxBytes + 1, 'a')) });
        await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({ code: 'TOO_LARGE' });
        expect(requests).toHaveLength(2);
    });

    it('allows the exact declared and streamed raw cap to reach decompression', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        replies.push({
            headers: { 'content-encoding': 'gzip', 'content-length': '40' },
            chunks: [Buffer.alloc(20, 'a'), Buffer.alloc(20, 'a')]
        });
        // 原始体积恰好 4 倍上限时不能误判 TOO_LARGE，损坏数据仍必须由解压器拒绝。
        await expect(requestUrl('http://public.example', { ...policy, maxBytes: 10 })).rejects.toMatchObject({
            code: 'NETWORK_ERROR',
            message: '响应解压失败'
        });
        expect(requests[0].response?.destroy).not.toHaveBeenCalled();
        expect(requests).toHaveLength(1);
    });

    it.each(compressionCases)(
        'limits %s decompression output against compression bombs',
        async (encoding, compress) => {
            replies.push({ headers: { 'content-encoding': encoding }, body: compress(Buffer.alloc(10_000)) });
            await expect(requestUrl('http://public.example', { ...policy, maxBytes: 100 })).rejects.toMatchObject({
                code: 'TOO_LARGE'
            });
        }
    );
});

describe('platform web fetcher: errors, deadline, abort and concurrency', () => {
    it.each([
        ['ENOTFOUND', 'DNS_FAILED'],
        ['EAI_AGAIN', 'DNS_FAILED'],
        ['ETIMEDOUT', 'TIMEOUT'],
        ['ECONNRESET', 'NETWORK_ERROR']
    ])('maps request error %s to %s', async (code, expected) => {
        replies.push({ requestError: Object.assign(new Error('transport error'), { code }) });
        await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({ code: expected });
    });

    it('maps response stream errors and non-Error throws', async () => {
        replies.push({ error: new Error('broken stream') });
        await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
        vi.mocked(http.request).mockImplementationOnce(() => {
            throw 'synchronous transport failure';
        });
        await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({
            code: 'NETWORK_ERROR',
            message: expect.stringContaining('synchronous transport failure')
        });
    });

    it('preserves WebAccessError from transport and releases its slot after sync throw', async () => {
        const error = new WebAccessError('DISABLED', 'disabled');
        vi.mocked(http.request).mockImplementationOnce(() => {
            throw error;
        });
        await expect(requestUrl('http://public.example', policy)).rejects.toBe(error);
        replies.push({});
        expect((await requestUrl('http://public.example', policy)).status).toBe(200);
    });

    it('rejects expired DNS deadline without creating a transport', async () => {
        vi.useFakeTimers();
        vi.mocked(dns.lookup).mockImplementationOnce(async () => {
            vi.advanceTimersByTime(501);
            return [{ address: '8.8.8.8', family: 4 }] as never;
        });
        await expect(requestUrl('http://public.example', policy)).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(requests).toHaveLength(0);
    });

    it('total timeout destroys a pending request and clears timer after failure', async () => {
        vi.useFakeTimers();
        replies.push({ hold: true });
        const result = requestUrl('http://public.example', policy);
        const check = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
        await settleMicrotasks();
        await vi.advanceTimersByTimeAsync(500);
        await check;
        expect(requests[0].destroy).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIMEOUT' }));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('shares one total deadline across redirects', async () => {
        vi.useFakeTimers();
        replies.push({ status: 302, headers: { location: '/next' }, hold: true }, { hold: true });
        const result = requestUrl('http://public.example', policy);
        const check = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
        await settleMicrotasks();
        await vi.advanceTimersByTimeAsync(400);
        requests[0].deliver();
        await settleMicrotasks();
        expect(requests).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(100);
        await check;
        expect(requests[1].destroy).toHaveBeenCalledWith(expect.objectContaining({ message: '抓取超时（100ms）' }));
    });

    it.each([false, true])('aborts request (already aborted: %s) and removes signal listeners', async (already) => {
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        if (already) controller.abort();
        replies.push({ hold: true });
        const result = requestUrl('http://public.example', policy, controller.signal);
        const check = expect(result).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: '请求已取消' });
        await settleMicrotasks();
        if (!already) controller.abort();
        await check;
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(requests[0].destroy).toHaveBeenCalledOnce();
    });

    it('clears timeout/listener on success so later abort cannot destroy completed request', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        replies.push({});
        await requestUrl('http://public.example', policy, controller.signal);
        controller.abort();
        expect(requests[0].destroy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('limits transport concurrency to four, advances FIFO waiters and releases failed slots', async () => {
        replies.push(...Array.from({ length: 6 }, () => ({ hold: true })));
        const results = Array.from({ length: 6 }, (_, i) => requestUrl(`http://public.example/${i}`, policy));
        const complete = Promise.allSettled(results);
        await settleMicrotasks();
        expect(requests).toHaveLength(4);
        requests[0].emit('error', new Error('first failed'));
        await settleMicrotasks();
        expect(requests).toHaveLength(5);
        expect(requests[4].url.pathname).toBe('/4');
        requests[1].deliver();
        await settleMicrotasks();
        expect(requests).toHaveLength(6);
        expect(requests[5].url.pathname).toBe('/5');
        for (const request of requests.slice(2)) request.deliver();
        const settled = await complete;
        expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(5);
        expect(settled[0]).toMatchObject({ status: 'rejected', reason: { code: 'NETWORK_ERROR' } });
    });
});

describe('platform web facade: extraction and audit over fake transport', () => {
    async function auditEntries(): Promise<Array<Record<string, unknown>>> {
        let records: Array<Record<string, unknown>> = [];
        await vi.waitFor(async () => {
            records = (await fsp.readFile(paths.webAuditFile(), 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(records.length).toBeGreaterThan(0);
        });
        return records;
    }

    it('extracts redirected HTML, truncates content and audits only metadata with masked URL', async () => {
        const rawUrl = 'https://public.example/article?token=secret-never-persist';
        replies.push(
            { status: 302, headers: { location: '/final' } },
            {
                headers: { 'content-type': 'text/html; charset=utf8' },
                body: Buffer.from(
                    '<html><title>页面标题</title><article><h1>正文标题</h1><p>' +
                        '可读内容'.repeat(40) +
                        '</p></article></html>'
                )
            }
        );
        const page = await fetchReadablePage(rawUrl, { ...policy, maxChars: 40 });
        expect(page).toMatchObject({
            url: rawUrl,
            finalUrl: 'https://public.example/final',
            title: '页面标题',
            contentType: 'text/html',
            truncated: true
        });
        expect(page.content).toContain('已省略中间');
        expect(page.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(page.bytesRead).toBeGreaterThan(40);
        const entries = await auditEntries();
        const record = entries.find((entry) => entry.ok === true);
        expect(record).toMatchObject({
            tool: 'WebFetch',
            host: 'public.example',
            status: 200,
            bytes: page.bytesRead,
            truncated: true,
            url: 'https://public.example/article?token=***'
        });
        expect(JSON.stringify(entries)).not.toContain('secret-never-persist');
        expect(record).not.toHaveProperty('content');
        expect(record).not.toHaveProperty('body');
    });

    it.each([
        { name: 'zero-byte text', mime: 'text/plain', body: '' },
        { name: 'whitespace text', mime: 'text/plain', body: ' \t\r\n ' },
        { name: 'whitespace markdown', mime: 'text/markdown', body: '\n \t' },
        { name: 'empty JSON response', mime: 'application/json', body: '' },
        { name: 'empty HTML', mime: 'text/html', body: '' },
        { name: 'empty body with title', mime: 'text/html', body: '<html><title>只有标题</title><body></body></html>' },
        {
            name: 'noise-only HTML',
            mime: 'text/html',
            body: '<body><!-- 注释 --><script>private-noise</script><style>p{color:red}</style><nav>导航</nav><footer>页脚</footer></body>'
        },
        { name: 'HTML whitespace entities', mime: 'text/html', body: '<body><p> &nbsp; \n </p></body>' },
        { name: 'noise without content type', mime: '', body: '<body><script>private-noise</script></body>' }
    ])('rejects $name as EMPTY_CONTENT and audits failure only', async ({ name, mime, body }) => {
        const auditUrl = `https://public.example/empty/${encodeURIComponent(name)}?token=***`;
        const rawUrl = auditUrl.replace('***', 'empty-secret');
        replies.push({ headers: { 'content-type': mime }, body: Buffer.from(body) });
        await expect(fetchReadablePage(rawUrl, { ...policy, maxChars: 100 })).rejects.toMatchObject({
            name: 'WebAccessError',
            code: 'EMPTY_CONTENT'
        });
        expect(requests).toHaveLength(1);
        await vi.waitFor(async () => {
            const entries = (await auditEntries()).filter((entry) => entry.url === auditUrl);
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ tool: 'WebFetch', ok: false, errorCode: 'EMPTY_CONTENT' });
            expect(entries[0]).not.toHaveProperty('content');
            expect(entries[0]).not.toHaveProperty('body');
            expect(JSON.stringify(entries)).not.toContain('empty-secret');
            expect(JSON.stringify(entries)).not.toContain('private-noise');
        });
    });

    it.each([
        { mime: 'text/plain', body: '好', content: '好' },
        { mime: 'text/markdown', body: '短', content: '短' },
        { mime: 'text/html', body: '<body><p>好</p></body>', content: '好' },
        { mime: 'application/json', body: 'null', content: 'null' },
        { mime: 'application/json', body: '[]', content: '[]' }
    ])('keeps short $mime content $content successful with a success audit', async ({ mime, body, content }) => {
        const rawUrl = `https://public.example/short/${encodeURIComponent(mime)}/${encodeURIComponent(content)}`;
        replies.push({ headers: { 'content-type': mime }, body: Buffer.from(body) });
        const page = await fetchReadablePage(rawUrl, { ...policy, maxChars: 100 });
        expect(page).toMatchObject({ content, truncated: false, bytesRead: Buffer.byteLength(body) });
        expect(requests).toHaveLength(1);
        await vi.waitFor(async () => {
            const entries = (await auditEntries()).filter((entry) => entry.url === rawUrl);
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ ok: true, status: 200, bytes: page.bytesRead, truncated: false });
            expect(entries[0]).not.toHaveProperty('errorCode');
        });
    });

    it.each(compressionCases)('audits corrupt %s as NETWORK_ERROR without retry or success', async (encoding) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const rawUrl = `https://public.example/corrupt-${encoding}?token=compressed-secret`;
        replies.push({
            headers: { 'content-type': 'text/plain', 'content-encoding': encoding },
            body: Buffer.from('private-corrupt-body')
        });
        await expect(fetchReadablePage(rawUrl, { ...policy, maxChars: 100 })).rejects.toMatchObject({
            code: 'NETWORK_ERROR',
            message: '响应解压失败'
        });
        expect(requests).toHaveLength(1);
        await vi.waitFor(async () => {
            const entries = (await auditEntries()).filter(
                (entry) => entry.url === `https://public.example/corrupt-${encoding}?token=***`
            );
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ tool: 'WebFetch', ok: false, errorCode: 'NETWORK_ERROR' });
            expect(entries[0]).not.toHaveProperty('content');
            expect(entries[0]).not.toHaveProperty('body');
            expect(JSON.stringify(entries)).not.toContain('compressed-secret');
            expect(JSON.stringify(entries)).not.toContain('private-corrupt-body');
        });
    });

    it.each(compressionCases)('treats valid %s containing empty text as EMPTY_CONTENT', async (encoding, compress) => {
        replies.push({
            headers: { 'content-type': 'text/plain', 'content-encoding': encoding },
            body: compress(Buffer.alloc(0))
        });
        await expect(
            fetchReadablePage('https://public.example/compressed-empty', { ...policy, maxChars: 100 })
        ).rejects.toMatchObject({ code: 'EMPTY_CONTENT' });
        expect(requests).toHaveLength(1);
    });

    it('accepts multibyte content at exact byte and character limits without truncating', async () => {
        const content = '短'.repeat(10);
        replies.push({ body: Buffer.from(content) });
        const page = await fetchReadablePage('https://public.example/exact', {
            ...policy,
            maxBytes: Buffer.byteLength(content),
            maxChars: content.length
        });
        expect(page).toMatchObject({ content, truncated: false, bytesRead: 30 });
    });

    it('returns nontruncated text and audits a stable access error', async () => {
        replies.push({ body: Buffer.from('small') });
        expect(await fetchReadablePage('https://public.example/small', { ...policy, maxChars: 100 })).toMatchObject({
            title: undefined,
            content: 'small',
            truncated: false,
            bytesRead: 5
        });
        replies.push({ status: 403, statusText: 'Forbidden' });
        await expect(
            fetchReadablePage('https://public.example/forbidden', { ...policy, maxChars: 100 })
        ).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 403 });
        await vi.waitFor(async () => {
            const entries = await auditEntries();
            // 同一审计文件已有其他失败记录，必须按本次 URL 定位，避免误读前序 EMPTY_CONTENT。
            expect(entries.find((entry) => entry.url === 'https://public.example/forbidden')).toMatchObject({
                ok: false,
                status: 403,
                errorCode: 'HTTP_ERROR'
            });
        });
    });

    it.each([
        { cause: new Error('extract failed'), message: 'extract failed' },
        { cause: 'non-error extraction failure', message: 'non-error extraction failure' }
    ])('normalizes unexpected failures and audits NETWORK_ERROR ($message)', async ({ cause, message }) => {
        const { default: iconv } = await import('iconv-lite');
        vi.spyOn(iconv, 'encodingExists').mockImplementationOnce(() => {
            throw cause;
        });
        // 在第三方编码边界注入异常，仍经过真实 transport/extract/facade，验证非标准异常的归一化。
        replies.push({ body: Buffer.from('<p>content</p>'), headers: { 'content-type': 'text/html; charset=utf8' } });
        const rawUrl = `https://public.example/bad-${message}`;
        await expect(fetchReadablePage(rawUrl, { ...policy, maxChars: 100 })).rejects.toMatchObject({
            code: 'NETWORK_ERROR',
            message
        });
        await vi.waitFor(async () => {
            expect(await auditEntries()).toContainEqual(
                expect.objectContaining({ url: new URL(rawUrl).href, ok: false, errorCode: 'NETWORK_ERROR' })
            );
        });
    });
});
