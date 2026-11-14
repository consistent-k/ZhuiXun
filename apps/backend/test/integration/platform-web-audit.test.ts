import fsp from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as AuditModule from '@/platform/web/audit';
import type { WebAuditEntry } from '@/platform/web/audit';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

// 日志出口完整隔离，审计本身仍真实走 paths 与 tmp 文件系统。
vi.mock('@/platform/logging/index', () => ({ createLogger: () => ({ warn }) }));

type AuditRecord = WebAuditEntry & { ts: string; host: string };
const platformTestHome = process.env.ZHUIXUN_TEST_HOME!;
const auditDir = path.join(platformTestHome, '.zhuixun', 'audit');
const auditFile = path.join(auditDir, 'web-audit.jsonl');
const realAppendFile = fsp.appendFile.bind(fsp);
let audit: typeof AuditModule;
let append: MockInstance<typeof fsp.appendFile>;
let mkdir: MockInstance<typeof fsp.mkdir>;

async function readRecords(): Promise<AuditRecord[]> {
    const text = await fsp.readFile(auditFile, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    return text
        .trimEnd()
        .split('\n')
        .map((line: string) => JSON.parse(line) as AuditRecord);
}

async function waitForRecords(count: number): Promise<AuditRecord[]> {
    let records: AuditRecord[] = [];
    // recordWebAudit 是 fire-and-forget；观察实际落盘完成，不以固定 sleep 猜测队列时序。
    await vi.waitFor(async () => {
        records = await readRecords();
        expect(records).toHaveLength(count);
    });
    return records;
}

function entry(overrides: Partial<WebAuditEntry> = {}): WebAuditEntry {
    return {
        tool: 'WebFetch',
        url: 'https://example.com/guide?topic=test',
        ms: 12,
        ok: true,
        ...overrides
    };
}

beforeEach(async () => {
    warn.mockReset();
    await fsp.rm(auditDir, { recursive: true, force: true });
    // homedir 已由首条 setup import 隔离；重新加载使每个用例获得独立队列与 mkdir 缓存。
    vi.resetModules();
    audit = await import('@/platform/web/audit');
    const { paths, ZHUIXUN_HOME } = await import('@/config/paths');
    expect(ZHUIXUN_HOME).toBe(path.join(platformTestHome, '.zhuixun'));
    expect(paths.auditDir()).toBe(auditDir);
    expect(paths.webAuditFile()).toBe(auditFile);
    append = vi.spyOn(fsp, 'appendFile');
    mkdir = vi.spyOn(fsp, 'mkdir');
});

afterEach(() => {
    append.mockRestore();
    mkdir.mockRestore();
});

describe('Web audit URL masking', () => {
    it.each([
        'token',
        'access_token',
        'key',
        'api_key',
        'apikey',
        'sig',
        'signature',
        'password',
        'passwd',
        'secret',
        'code',
        'auth',
        'ToKeN',
        'API_KEY'
    ])('masks the exact sensitive query key %s', (key) => {
        const masked = new URL(audit.maskUrl(`https://example.com/path?${key}=private-value&topic=public#section`));
        expect(masked.searchParams.get(key)).toBe('***');
        expect(masked.searchParams.get('topic')).toBe('public');
        expect(masked.pathname).toBe('/path');
        expect(masked.hash).toBe('#section');
        expect(masked.href).not.toContain('private-value');
    });

    it('masks repeated/encoded sensitive keys and preserves unrelated query names', () => {
        const masked = new URL(
            audit.maskUrl(
                'https://example.com/?token=first&token=second&%61uth=third&mytoken=safe&keynote=ok&topic=a+b'
            )
        );
        expect(masked.searchParams.getAll('token')).toEqual(['***']);
        expect(masked.searchParams.get('auth')).toBe('***');
        expect(masked.searchParams.get('mytoken')).toBe('safe');
        expect(masked.searchParams.get('keynote')).toBe('ok');
        expect(masked.searchParams.get('topic')).toBe('a b');
    });

    it('preserves a valid URL without query secrets and returns malformed input unchanged', () => {
        expect(audit.maskUrl('https://example.com/path')).toBe('https://example.com/path');
        expect(audit.maskUrl('not a URL')).toBe('not a URL');
    });
});

describe('Web audit persistence under temporary homedir', () => {
    it('writes one JSONL record with timestamp, derived host and masked URL', async () => {
        const started = Date.now();
        expect(
            audit.recordWebAudit(
                entry({ url: 'https://example.com:443/guide?token=do-not-persist', status: 200, bytes: 87 })
            )
        ).toBeUndefined();
        const [record] = await waitForRecords(1);
        expect(record).toMatchObject({
            tool: 'WebFetch',
            host: 'example.com',
            status: 200,
            bytes: 87,
            ms: 12,
            ok: true
        });
        expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
        expect(Date.parse(record.ts)).toBeGreaterThanOrEqual(started);
        expect(Date.parse(record.ts)).toBeLessThanOrEqual(Date.now());
        expect(new URL(record.url).searchParams.get('token')).toBe('***');
        expect(await fsp.readFile(auditFile, 'utf8')).not.toContain('do-not-persist');
        expect(mkdir).toHaveBeenCalledExactlyOnceWith(auditDir, { recursive: true });
        expect(append).toHaveBeenCalledWith(auditFile, expect.stringMatching(/\n$/), 'utf8');
        expect(warn).not.toHaveBeenCalled();
    });

    it('persists explicit host, failure metadata and truncation without modifying the caller entry', async () => {
        const input = entry({
            url: 'https://example.com:80/path?API_KEY=private-value',
            host: 'pinned.example',
            status: 429,
            bytes: 4096,
            ms: 31,
            ok: false,
            errorCode: 'HTTP_ERROR',
            truncated: true
        });
        const original = { ...input };
        audit.recordWebAudit(input);
        const [record] = await waitForRecords(1);
        expect(record).toMatchObject({
            host: 'pinned.example',
            status: 429,
            bytes: 4096,
            ms: 31,
            ok: false,
            errorCode: 'HTTP_ERROR',
            truncated: true
        });
        expect(input).toEqual(original);
        expect(record.url).not.toContain('private-value');
    });

    it('derives host including a nondefault port and handles an invalid URL', async () => {
        audit.recordWebAudit(entry({ url: 'https://example.com:80/path' }));
        audit.recordWebAudit(entry({ url: 'invalid URL', ok: false, errorCode: 'INVALID_URL' }));
        audit.recordWebAudit(entry({ host: '' }));
        const records = await waitForRecords(3);
        expect(records.map((record) => record.host)).toEqual(['example.com:80', '', '']);
        expect(records[1]).toMatchObject({ url: 'invalid URL', ok: false, errorCode: 'INVALID_URL' });
        expect(records[1]).not.toHaveProperty('status');
        expect(records[1]).not.toHaveProperty('bytes');
        expect(records[1]).not.toHaveProperty('truncated');
    });

    it('serializes pending writes in call order and creates the directory only once', async () => {
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        append.mockImplementationOnce(async (...args) => {
            started();
            await gate;
            await realAppendFile(...args);
        });
        try {
            for (let i = 0; i < 8; i++) audit.recordWebAudit(entry({ url: `https://example.com/${i}` }));
            await firstStarted;
            expect(append).toHaveBeenCalledTimes(1);
        } finally {
            release();
        }
        const records = await waitForRecords(8);
        expect(records.map((record) => new URL(record.url).pathname)).toEqual(
            Array.from({ length: 8 }, (_, i) => `/${i}`)
        );
        expect(mkdir).toHaveBeenCalledTimes(1);
        expect(append).toHaveBeenCalledTimes(8);
    });

    it('warns on append failure but continues processing the next audit entry', async () => {
        const failure = new Error('disk full');
        append.mockRejectedValueOnce(failure);
        expect(() => audit.recordWebAudit(entry({ url: 'https://example.com/failed' }))).not.toThrow();
        audit.recordWebAudit(entry({ url: 'https://example.com/recovered' }));
        const [record] = await waitForRecords(1);
        expect(record.url).toBe('https://example.com/recovered');
        expect(warn).toHaveBeenCalledExactlyOnceWith('Web 审计写入失败', { err: failure });
        expect(append).toHaveBeenCalledTimes(2);
        expect(mkdir).toHaveBeenCalledTimes(1);
    });

    it('contains directory-creation failures without attempting to append outside the tmp root', async () => {
        const failure = new Error('mkdir denied');
        mkdir.mockRejectedValueOnce(failure);
        expect(() => audit.recordWebAudit(entry())).not.toThrow();
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalledExactlyOnceWith('Web 审计写入失败', { err: failure });
        });
        expect(mkdir).toHaveBeenCalledExactlyOnceWith(auditDir, { recursive: true });
        expect(append).not.toHaveBeenCalled();
    });
});
