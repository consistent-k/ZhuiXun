import fs from 'node:fs/promises';
import path from 'node:path';

import type { UIMessage } from 'ai';
import ExcelJS from 'exceljs';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractAttachmentText, isExtractable, isTextLike } from '@/modules/chat/attachments/extract';
import { normalizeAttachments } from '@/modules/chat/attachments/normalize';
import {
    ALLOWED_ATTACHMENT_TYPES,
    canStoreAttachment,
    isAllowedAttachment,
    MAX_FILE_BYTES,
    MAX_IMAGE_BYTES,
    parseAttachmentRef,
    readAttachment,
    removeSessionAttachments,
    saveAttachment
} from '@/modules/chat/attachments/store';

import { setEnv } from '../helpers/env';
import type { TempData } from '../helpers/temp-data';
import { createTempData } from '../helpers/temp-data';

const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => log }));

const csvType = 'text/csv';
const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const binaryType = 'application/octet-stream';
const sid = 'conversation-1';

function archive(files: Record<string, string>): Uint8Array {
    return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

// mammoth 用 saxophonist 做命名空间感知解析，匹配的是 `w:body`：缺 xmlns:w 声明的
// 极简 fixture 会被判「Could not find the body element」。真实 .docx 总带命名空间声明。
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function extract(filename: string, content: string | Uint8Array, mediaType = binaryType): Promise<string | null> {
    return extractAttachmentText(mediaType, filename, typeof content === 'string' ? strToU8(content) : content);
}

function user(parts: unknown[], id = 'user-1'): UIMessage {
    return { id, role: 'user', parts } as UIMessage;
}

// exceljs 生成真实 xlsx fixture（手写 XML zip 缺 [Content_Types]/workbook 等，exceljs 读不了——
// 这也正是替换手写提取器的原因：只认真实文件形态）。
async function makeXlsx(rows: (string | number | boolean)[][]): Promise<Uint8Array> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    for (const row of rows) ws.addRow(row);
    return Buffer.from(await wb.xlsx.writeBuffer());
}

let temp: TempData;
let restoreEnv: () => void;

beforeEach(async () => {
    temp = await createTempData('zhuixun-chat-attachments-');
    restoreEnv = setEnv({ SESSIONS_USER_DIR: temp.sessions });
    log.warn.mockClear();
});
afterEach(async () => {
    vi.restoreAllMocks();
    restoreEnv();
    await temp.cleanup();
});

describe('attachment type classification', () => {
    it.each(ALLOWED_ATTACHMENT_TYPES)('allows the declared MIME %s', (mediaType) => {
        expect(isAllowedAttachment(mediaType, 'upload')).toBe(true);
    });

    it.each(['report.TXT', 'module.tsx', 'query.sql', 'settings.yaml', 'notes.markdown', 'script.py', 'local.env'])(
        'accepts text-like filename %s even when its MIME is unreliable',
        (filename) => {
            expect(isTextLike(filename, 'video/mp2t')).toBe(true);
            expect(isAllowedAttachment('video/mp2t', filename)).toBe(true);
            expect(isExtractable('video/mp2t', filename)).toBe(true);
        }
    );

    it.each(['text/plain', 'text/markdown'])('uses text MIME %s for extensionless files', (mediaType) => {
        expect(isTextLike('README', mediaType)).toBe(true);
        expect(isExtractable(mediaType)).toBe(true);
    });

    it.each(['rows.CSV', 'report.XLSX', 'report.DOCX'])('extracts document extension %s without a MIME', (filename) => {
        expect(isExtractable('', filename)).toBe(true);
    });

    it('keeps multimodal files and unknown binary types out of text extraction', () => {
        expect(isTextLike('blob')).toBe(false);
        expect(isExtractable('image/png', 'photo.png')).toBe(false);
        expect(isExtractable('application/pdf', 'report.pdf')).toBe(false);
        expect(isExtractable(binaryType, 'legacy.xls')).toBe(false);
        expect(isAllowedAttachment(binaryType, 'payload.exe')).toBe(false);
        expect(isAllowedAttachment('', 'report.xlsx')).toBe(false);
        expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
        expect(MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
    });
});

describe('extractAttachmentText', () => {
    it('removes BOM, preserves text whitespace and distinguishes an empty file', async () => {
        expect(await extract('source.ts', '﻿const value = 1;\n')).toBe('const value = 1;\n');
        expect(await extract('README', 'plain text', 'text/plain')).toBe('plain text');
        expect(await extract('notes.md', '')).toBe('（空文件）');
        expect(await extract('notes.md', '  \n')).toBe('  \n');
    });

    it('truncates only content beyond the 20,000 character budget', async () => {
        expect(await extract('long.txt', 'x'.repeat(20_000))).toBe('x'.repeat(20_000));
        expect(await extract('long.txt', 'x'.repeat(20_001))).toBe(`${'x'.repeat(20_000)}\n…（内容过长已截断）`);
    });

    it('parses CSV BOM, CRLF, quoted commas, escaped quotes, empty cells and markdown pipes', async () => {
        const csv = '﻿name,note,empty\r\n"A, B","He said ""yes""|ok",\r\n\r\nlast,,tail\r\n';
        expect(await extract('data.csv', csv)).toBe(
            '| name | note | empty |\n| --- | --- | --- |\n| A, B | He said "yes"\\|ok |  |\n| last |  | tail |'
        );
    });

    it.each(['text/csv', 'application/csv'])('selects CSV extraction by MIME %s', async (mediaType) => {
        expect(await extract('download', 'a,b\n1,2', mediaType)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    });

    it('handles empty CSV and caps rows including the header', async () => {
        expect(await extract('empty.csv', '﻿\r\n\n')).toBe('（空表格）');
        const result = (await extract(
            'rows.csv',
            Array.from({ length: 502 }, (_, index) => String(index)).join('\n')
        ))!;
        expect(result.split('\n')).toHaveLength(501);
        expect(result.endsWith('| 499 |')).toBe(true);
        expect(result).not.toContain('| 500 |');
    });

    it('applies the character budget after rendering CSV tables', async () => {
        const result = (await extract('huge.csv', `header\n${'x'.repeat(20_001)}`))!;
        expect(result).toHaveLength(20_000 + '\n…（内容过长已截断）'.length);
        expect(result.endsWith('…（内容过长已截断）')).toBe(true);
    });

    it('selects XLSX extraction by MIME without a filename extension', async () => {
        const data = await makeXlsx([
            ['a', 'b'],
            [1, 2]
        ]);
        expect(await extract('download', data, xlsxType)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    });

    it('renders XLSX numbers, text and empty cells as a markdown table', async () => {
        const data = await makeXlsx([
            ['na&me', '<tag>', 'pipe|line\nnext'],
            [42, '', 7]
        ]);
        expect(await extract('sheet.xlsx', data)).toBe(
            '| na&me | <tag> | pipe\\|line next |\n| --- | --- | --- |\n| 42 |  | 7 |'
        );
    });

    it('selects the first sheet and fills column gaps to the widest row', async () => {
        const wb = new ExcelJS.Workbook();
        wb.addWorksheet('Sheet1').addRow(['first', '1']);
        wb.addWorksheet('Sheet2').addRow(['second']);
        expect(await extract('multi.xlsx', Buffer.from(await wb.xlsx.writeBuffer()))).toBe(
            '| first | 1 |\n| --- | --- |'
        );
        expect(await extract('ragged.xlsx', await makeXlsx([['a'], ['b', 'c']]))).toBe(
            '| a |  |\n| --- | --- |\n| b | c |'
        );
    });

    it('decodes multi-letter XLSX columns and fills gaps', async () => {
        const wb = new ExcelJS.Workbook();
        wb.addWorksheet('Sheet1').getCell('AA1').value = 27;
        const header = (await extract('wide.xlsx', Buffer.from(await wb.xlsx.writeBuffer())))!.split('\n')[0];
        expect(header).toBe(`| ${[...Array<string>(26).fill(''), '27'].join(' | ')} |`);
    });

    it('renders formula results, hyperlink text, rich text and error values', async () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Sheet1');
        ws.getCell('A1').value = { formula: 'SUM(A2:A3)', result: 3 };
        ws.getCell('B1').value = { text: '链接', hyperlink: 'https://example.com' };
        ws.getCell('C1').value = { richText: [{ text: '粗', font: { bold: true } }, { text: '体' }] };
        ws.getCell('D1').value = { error: '#DIV/0!' };
        expect(await extract('composite.xlsx', Buffer.from(await wb.xlsx.writeBuffer()))).toBe(
            '| 3 | 链接 | 粗体 | #DIV/0! |\n| --- | --- | --- | --- |'
        );
    });

    it('handles empty sheets and rejects unreadable xlsx archives', async () => {
        expect(await extract('empty.xlsx', await makeXlsx([]))).toBe('（空表格）');
        // 合法 zip 但缺 workbook 部件：exceljs 返回空 worksheets → 判「未找到工作表」
        expect(await extract('none.xlsx', archive({ 'other.xml': '<empty/>' }))).toBe('（未找到工作表）');
    });

    it('caps XLSX rows and truncates oversized cell text', async () => {
        const rows = Array.from({ length: 501 }, (_, index) => [index]);
        const result = (await extract('rows.xlsx', await makeXlsx(rows)))!;
        expect(result.split('\n')).toHaveLength(501);
        expect(result.endsWith('| 499 |')).toBe(true);
        expect(result).not.toContain('| 500 |');
        const oversized = await makeXlsx([['x'.repeat(20_001)]]);
        expect((await extract('huge.xlsx', oversized))!.endsWith('…（内容过长已截断）')).toBe(true);
    });

    it('extracts DOCX paragraphs/runs, unescapes XML and skips whitespace-only paragraphs', async () => {
        const data = archive({
            'word/document.xml':
                `<w:document ${W}><w:body><w:p><w:r><w:t>第一</w:t></w:r><w:r><w:t>段&amp;&lt;&gt;&quot;&apos;</w:t></w:r></w:p>` +
                '<w:p><w:r><w:t>  </w:t></w:r></w:p><w:p/><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>'
        });
        expect(await extract('document.docx', data)).toBe('第一段&<>"\'\n\n第二段');
        expect(await extract('download', data, docxType)).toBe('第一段&<>"\'\n\n第二段');
    });

    it('includes DOCX table cell text that regex extraction missed', async () => {
        const data = archive({
            'word/document.xml': `<w:document ${W}><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`
        });
        expect(await extract('table.docx', data)).toBe('单元格');
    });

    it('handles missing or empty DOCX body including paragraphs without text nodes', async () => {
        expect(await extract('missing.docx', archive({ 'other.xml': '<empty/>' }))).toBe('（未找到文档正文）');
        expect(
            await extract('empty.docx', archive({ 'word/document.xml': `<w:document ${W}><w:body/></w:document>` }))
        ).toBe('（空文档）');
        expect(
            await extract(
                'blank.docx',
                archive({ 'word/document.xml': `<w:document ${W}><w:body><w:p><w:r/></w:p></w:body></w:document>` })
            )
        ).toBe('（空文档）');
    });

    it('caps DOCX paragraphs and truncates oversized text', async () => {
        const paragraphs = Array.from({ length: 501 }, (_, index) => `<w:p><w:t>${index}</w:t></w:p>`).join('');
        const result = (await extract(
            'rows.docx',
            archive({ 'word/document.xml': `<w:document ${W}><w:body>${paragraphs}</w:body></w:document>` })
        ))!;
        expect(result.split('\n\n')).toHaveLength(500);
        expect(result.endsWith('499')).toBe(true);
        expect(
            await extract(
                'huge.docx',
                archive({
                    'word/document.xml': `<w:document ${W}><w:body><w:p><w:t>${'x'.repeat(20_001)}</w:t></w:p></w:body></w:document>`
                })
            )
        ).toBe(`${'x'.repeat(20_000)}\n…（内容过长已截断）`);
    });

    it('returns null for unsupported binary formats and corrupt archives without interrupting the turn', async () => {
        expect(await extract('legacy.xls', 'binary bytes', 'application/vnd.ms-excel')).toBeNull();
        expect(await extract('report.pdf', 'pdf bytes', 'application/pdf')).toBeNull();
        // exceljs 对 'not a zip' 抛 jszip 错误（不像 SheetJS 嗅探成 CSV），上层降级为 null
        expect(await extract('broken.xlsx', 'not a zip')).toBeNull();
        expect(await extract('broken.docx', 'not a zip')).toBeNull();
        expect(log.warn).toHaveBeenCalledTimes(2);
        expect(log.warn).toHaveBeenCalledWith('附件文本提取失败', {
            filename: 'broken.xlsx',
            mediaType: binaryType,
            err: expect.any(String)
        });
    });
});

describe('attachment store with tempFS', () => {
    it.each(['', '../outside', 'a/b', 'a\\b', 'x'.repeat(129)])('rejects unsafe session id %j', async (sessionId) => {
        expect(canStoreAttachment(sessionId)).toBe(false);
        await expect(
            saveAttachment(sessionId, { data: strToU8('x'), filename: 'a.txt', mediaType: 'text/plain' })
        ).rejects.toThrow('非法会话 id');
        await expect(readAttachment(sessionId, 'file-1')).resolves.toBeNull();
        await expect(removeSessionAttachments(sessionId)).resolves.toBeUndefined();
    });

    it('persists exact bytes and metadata for a draft session, generating unique references', async () => {
        expect(canStoreAttachment(sid)).toBe(true);
        const data = new Uint8Array([0, 255, 10, 128]);
        const input = { data, filename: '原始报告.png', mediaType: 'image/png' };
        const saved = await saveAttachment(sid, input);
        const second = await saveAttachment(sid, input);
        expect(saved.id).not.toBe(second.id);
        expect(saved).toEqual({
            id: expect.any(String),
            filename: input.filename,
            mediaType: input.mediaType,
            size: 4,
            url: `/api/chat/files/${sid}/${saved.id}`
        });
        const uploads = path.join(temp.sessions, sid, 'uploads');
        const meta = JSON.parse(await fs.readFile(path.join(uploads, `${saved.id}.meta.json`), 'utf8'));
        expect(meta).toEqual({
            filename: input.filename,
            mediaType: input.mediaType,
            size: 4,
            createdAt: expect.any(Number)
        });
        expect(new Uint8Array(await fs.readFile(path.join(uploads, saved.id)))).toEqual(data);
        await expect(readAttachment(sid, saved.id)).resolves.toEqual({ data, meta });
        expect(parseAttachmentRef(saved.url)).toEqual({ sid, id: saved.id });
        await expect(fs.stat(path.join(temp.sessions, `${sid}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['missing', 'malformed'])('falls back to binary metadata when the sidecar is %s', async (mode) => {
        const saved = await saveAttachment(sid, {
            data: strToU8('abc'),
            filename: 'name.txt',
            mediaType: 'text/plain'
        });
        const metaFile = path.join(temp.sessions, sid, 'uploads', `${saved.id}.meta.json`);
        if (mode === 'missing') await fs.unlink(metaFile);
        else await fs.writeFile(metaFile, '{invalid');
        await expect(readAttachment(sid, saved.id)).resolves.toEqual({
            data: strToU8('abc'),
            meta: { filename: saved.id, mediaType: binaryType, size: 3, createdAt: 0 }
        });
    });

    it('returns null for unsafe attachment ids and absent files without filesystem access or warnings', async () => {
        const read = vi.spyOn(fs, 'readFile');
        for (const id of ['', '../outside', 'a/b', 'a\\b', 'x'.repeat(129)]) {
            await expect(readAttachment(sid, id)).resolves.toBeNull();
        }
        expect(read).not.toHaveBeenCalled();
        await expect(readAttachment(sid, 'missing')).resolves.toBeNull();
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('logs non-ENOENT read errors and returns null', async () => {
        const failure = Object.assign(new Error('read denied'), { code: 'EACCES' });
        vi.spyOn(fs, 'readFile').mockRejectedValueOnce(failure);
        await expect(readAttachment(sid, 'file-1')).resolves.toBeNull();
        expect(log.warn).toHaveBeenCalledExactlyOnceWith('读取附件失败', {
            sessionId: sid,
            id: 'file-1',
            err: failure
        });
    });

    it('removes only the requested session directory and tolerates repeated cleanup', async () => {
        const first = await saveAttachment(sid, { data: strToU8('a'), filename: 'a.txt', mediaType: 'text/plain' });
        const second = await saveAttachment('conversation-2', {
            data: strToU8('b'),
            filename: 'b.txt',
            mediaType: 'text/plain'
        });
        await removeSessionAttachments(sid);
        await removeSessionAttachments(sid);
        await expect(readAttachment(sid, first.id)).resolves.toBeNull();
        await expect(readAttachment('conversation-2', second.id)).resolves.toMatchObject({ data: strToU8('b') });
        await expect(fs.stat(path.join(temp.sessions, sid))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('logs cleanup failure without rejecting', async () => {
        const failure = new Error('filesystem unavailable');
        vi.spyOn(fs, 'rm').mockRejectedValueOnce(failure);
        await expect(removeSessionAttachments(sid)).resolves.toBeUndefined();
        expect(log.warn).toHaveBeenCalledExactlyOnceWith('清理会话附件目录失败（忽略）', {
            sessionId: sid,
            err: failure
        });
    });

    it.each([
        ['/api/chat/files/session-1/file_1', { sid: 'session-1', id: 'file_1' }],
        [
            'http://127.0.0.1:31001/api/chat/files/session-1/file-1?download=1#preview',
            { sid: 'session-1', id: 'file-1' }
        ],
        ['/api/chat/files/session%2D1/file%5F1', { sid: 'session-1', id: 'file_1' }],
        ['data:text/plain;base64,YQ==', null],
        ['https://example.invalid/document.pdf', null],
        ['/api/chat/files/only-session', null],
        ['/api/chat/files/session/', null]
    ] as const)('parses attachment ref %s', (url, expected) => {
        expect(parseAttachmentRef(url)).toEqual(expected);
    });
});

describe('normalizeAttachments with the real store and extractor', () => {
    it('returns a new array but preserves untouched messages, external/data URLs and non-file parts by identity', async () => {
        const messages: UIMessage[] = [
            user([
                { type: 'text', text: 'question' },
                { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,YQ==' },
                { type: 'file', mediaType: 'application/pdf', url: 'https://example.invalid/report.pdf' },
                { type: 'file', url: 123 },
                null
            ]),
            { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
            { id: 'malformed', role: 'user' } as UIMessage
        ];
        const normalized = await normalizeAttachments(messages);
        expect(normalized).not.toBe(messages);
        normalized.forEach((message, index) => expect(message).toBe(messages[index]));
        await expect(normalizeAttachments([])).resolves.toEqual([]);
    });

    it('extracts stored text/CSV/DOCX and inlines image/PDF bytes without mutating persisted references', async () => {
        const inputFiles = [
            { filename: 'source.ts', mediaType: 'video/mp2t', data: strToU8('const x = 1;') },
            { filename: 'data.csv', mediaType: csvType, data: strToU8('a,b\n1,2') },
            {
                filename: 'notes.docx',
                mediaType: docxType,
                data: archive({
                    'word/document.xml': `<w:document ${W}><w:body><w:p><w:t>段落</w:t></w:p></w:body></w:document>`
                })
            },
            { filename: 'photo.png', mediaType: 'image/png', data: new Uint8Array([0, 255, 128]) },
            { filename: 'report.pdf', mediaType: 'application/pdf', data: strToU8('%PDF-test') }
        ];
        const stored = await Promise.all(inputFiles.map((file) => saveAttachment(sid, file)));
        const textPart = { type: 'text', text: '请分析附件' };
        const parts = stored.map(({ url }) => ({ type: 'file', url }));
        const message = user([textPart, ...parts]);
        const before = structuredClone(message);
        const [normalized] = await normalizeAttachments([message]);
        expect(normalized).not.toBe(message);
        expect(normalized.parts[0]).toBe(textPart);
        expect(normalized.parts.slice(1, 4)).toEqual([
            { type: 'text', text: '\n\n【附件：source.ts】\nconst x = 1;\n' },
            { type: 'text', text: '\n\n【附件：data.csv】\n| a | b |\n| --- | --- |\n| 1 | 2 |\n' },
            { type: 'text', text: '\n\n【附件：notes.docx】\n段落\n' }
        ]);
        expect(normalized.parts.slice(4)).toEqual(
            inputFiles.slice(3).map(({ filename, mediaType, data }) => ({
                type: 'file',
                filename,
                mediaType,
                url: `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
            }))
        );
        expect(message).toEqual(before);
        expect(message.parts[1]).toBe(parts[0]);
    });

    it('honors per-message filename and MIME overrides instead of stored metadata', async () => {
        const saved = await saveAttachment(sid, {
            filename: 'original.bin',
            mediaType: binaryType,
            data: strToU8('text')
        });
        const [normalized] = await normalizeAttachments([
            user([{ type: 'file', filename: 'renamed.md', mediaType: 'text/plain', url: saved.url }])
        ]);
        expect(normalized.parts).toEqual([{ type: 'text', text: '\n\n【附件：renamed.md】\ntext\n' }]);
    });

    it('also applies explicit filename/MIME overrides to binary inlining', async () => {
        const saved = await saveAttachment(sid, {
            filename: 'original.png',
            mediaType: 'image/png',
            data: strToU8('x')
        });
        const [normalized] = await normalizeAttachments([
            user([{ type: 'file', filename: 'preview.pdf', mediaType: 'application/pdf', url: saved.url }])
        ]);
        expect(normalized.parts).toEqual([
            {
                type: 'file',
                filename: 'preview.pdf',
                mediaType: 'application/pdf',
                url: 'data:application/pdf;base64,eA=='
            }
        ]);
    });

    it('drops missing and unparseable files, appending one aggregate explanation after preserved parts', async () => {
        const broken = await saveAttachment(sid, {
            filename: 'broken.docx',
            mediaType: docxType,
            data: strToU8('bad zip')
        });
        const legacy = await saveAttachment(sid, {
            filename: 'legacy.xls',
            mediaType: 'application/vnd.ms-excel',
            data: strToU8('old format')
        });
        const text = { type: 'text', text: 'question' };
        const external = { type: 'file', mediaType: 'image/png', url: 'https://example.invalid/image.png' };
        const message = user([
            { type: 'file', filename: 'missing.pdf', url: `/api/chat/files/${sid}/missing` },
            text,
            { type: 'file', url: `/api/chat/files/${sid}/missing-without-label` },
            { type: 'file', filename: 'broken.docx', url: broken.url },
            external,
            { type: 'file', url: legacy.url }
        ]);
        const [normalized] = await normalizeAttachments([message]);
        expect(normalized.parts).toEqual([
            text,
            external,
            {
                type: 'text',
                text: '\n\n（已忽略 4 个已失效或无法解析的附件：missing.pdf（已失效）、附件（已失效）、broken.docx、附件）'
            }
        ]);
        expect(normalized.parts[0]).toBe(text);
        expect(normalized.parts[1]).toBe(external);
        expect(message.parts).toHaveLength(6);
    });

    it('does not resolve local-looking references in assistant messages', async () => {
        const assistant: UIMessage = {
            id: 'assistant-1',
            role: 'assistant',
            parts: [
                {
                    type: 'file',
                    filename: 'missing.pdf',
                    mediaType: 'application/pdf',
                    url: `/api/chat/files/${sid}/missing`
                }
            ]
        };
        const [normalized] = await normalizeAttachments([assistant]);
        expect(normalized).toBe(assistant);
    });
});
