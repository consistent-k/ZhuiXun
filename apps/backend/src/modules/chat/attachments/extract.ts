import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import * as mammoth from 'mammoth';

import { createLogger } from '@/platform/logging/index';

const log = createLogger('Attachments:Extract');

/** 可被服务端提取为文本的附件类型（不依赖模型多模态能力） */
export const EXTRACTABLE_TYPES = [
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel', // 部分浏览器给 .csv 标的 MIME（.xls 旧二进制不解析，见下）
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'text/plain',
    'text/markdown'
] as const;

/**
 * 纯文本 / 代码类文件扩展名：直接按 UTF-8 读入作为文本注入。
 * 代码文件的 MIME 极不可靠（浏览器常给空串或 video/mp2t 之类），故以扩展名为准。
 */
const TEXT_LIKE_RE =
    /\.(txt|md|markdown|log|json|jsonc|ya?ml|toml|ini|conf|xml|html?|css|s[ac]ss|less|c|h|cc|cpp|hpp|cs|go|rs|java|kt|kts|rb|php|py|pyi|sh|bash|zsh|sql|js|mjs|cjs|jsx|ts|tsx|vue|svelte|env|properties|gradle|dockerfile)$/i;

/** 提取结果注入模型的字符预算与行数上限，避免超大表格导致上下文超限 */
const MAX_CHARS = 20_000;
const MAX_ROWS = 500;

/** 是否为纯文本 / 代码类文件（按扩展名，MIME 仅作补充） */
export function isTextLike(filename: string, mediaType = ''): boolean {
    if (mediaType === 'text/plain' || mediaType === 'text/markdown') return true;
    return TEXT_LIKE_RE.test(filename);
}

/** 判断某 mediaType / 文件名是否走「服务端提取为文本」路径（.xls 旧二进制不在内） */
export function isExtractable(mediaType: string, filename = ''): boolean {
    if ((EXTRACTABLE_TYPES as readonly string[]).includes(mediaType)) return true;
    if (isTextLike(filename, mediaType)) return true;
    return /\.(csv|xlsx|docx)$/i.test(filename);
}

/** 把一行单元格渲染为 Markdown 表格行 */
function toRow(cells: string[]): string {
    return `| ${cells.map((c) => c.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |`;
}

function truncate(text: string): string {
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（内容过长已截断）` : text;
}

/**
 * CSV → Markdown 表格。
 * 用 csv-parse 处理引号内换行、转义引号等边界——手写解析器只支持双引号包裹与字段内逗号，
 * Excel 导出的「引号内换行」会解析错、丢字段。
 */
function extractCsv(data: Uint8Array): string {
    // 去掉 UTF-8 BOM（\uFEFF），用转义而非字面量，避免 no-irregular-whitespace
    const text = strFromU8(data).replace(/^\uFEFF/, '');
    // 全空白（含 BOM+CRLF）判空表格：csv-parse 会把 '\r\n\n' 解析成一行空字段 ['']，
    // skip_empty_lines 只跳过「无字段的行」，单空字段行不会被跳过
    if (!text.trim()) return '（空表格）';
    // relax_column_count：各行列数不必与首行一致（真实 CSV 常有长短行）
    const rows = parseCsv(text, { skip_empty_lines: true, relax_column_count: true }) as unknown[][];
    if (rows.length === 0) return '（空表格）';
    const limited = rows.slice(0, MAX_ROWS).map((row) => (Array.isArray(row) ? row : []).map((cell) => String(cell)));
    const header = limited[0];
    const sep = `| ${header.map(() => '---').join(' | ')} |`;
    return truncate([toRow(header), sep, ...limited.slice(1).map(toRow)].join('\n'));
}

/**
 * 单元格值 → 文本（exceljs 会返回 number/boolean/Date/复合对象，统一转字符串）。
 * 复合对象：公式取缓存 result、超链接取显示文本、富文本拼接、错误值原样输出。
 */
function renderCell(cell: unknown): string {
    if (cell === null || cell === undefined) return '';
    if (typeof cell === 'object') {
        const v = cell as {
            result?: unknown;
            text?: unknown;
            richText?: Array<{ text?: unknown }>;
            error?: unknown;
        };
        if ('result' in v) return renderCell(v.result); // 公式：读缓存结果（无缓存时为 undefined → '')
        if (Array.isArray(v.richText)) return v.richText.map((r) => String(r.text ?? '')).join(''); // 富文本
        if ('text' in v) return String(v.text); // 超链接：显示文本
        if ('error' in v) return String(v.error); // 错误值（#DIV/0! 等）
    }
    return String(cell);
}

/**
 * XLSX → Markdown 表格（首张工作表）。
 * 用 exceljs 解析：完整支持合并单元格、多 sheet、公式缓存、日期、富文本、超链接等真实文件形态
 * ——手写 fflate+XML 提取对复杂/真实文件会漏内容。exceljs 对损坏 zip 抛错（上层降级为 null），
 * 对「合法 zip 但缺 workbook 部件」返回空 worksheets（判「未找到工作表」）。
 */
async function extractXlsx(data: Uint8Array): Promise<string> {
    const wb = new ExcelJS.Workbook();
    // exceljs 自声明 `interface Buffer extends ArrayBuffer`（index.d.ts 顶层，非 Node 的 Buffer 类），
    // load 参数须是 ArrayBuffer 形状——Node Buffer 反而类型不匹配。复制到独立 ArrayBuffer 传入
    // （同时消除传入视图的 byteOffset 语义），运行时对 Uint8Array/Buffer 同样接受。
    const ab = new Uint8Array(data.byteLength);
    ab.set(data);
    await wb.xlsx.load(ab.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return '（未找到工作表）';
    // 逐行收集有值行（跳空行），最多 MAX_ROWS 行。rowCount 是物理行号上界（含空行），
    // actualRowCount 是「有值行数量」，直接用它作上界会漏掉空行之后的真实数据行。
    const rows: unknown[][] = [];
    for (let r = 1; r <= ws.rowCount && rows.length < MAX_ROWS; r++) {
        const values = ws.getRow(r).values;
        const cells = Array.isArray(values) ? values.slice(1) : [];
        if (cells.length === 0 || cells.every((c) => c == null)) continue;
        rows.push(cells);
    }
    if (rows.length === 0) return '（空表格）';
    // 按整表最大列数补齐空单元格，保证各行列数一致
    const colCount = ws.columnCount;
    const padded = rows.map((row) => {
        const cells: string[] = [];
        for (let c = 0; c < colCount; c++) cells.push(renderCell(row[c]));
        return cells;
    });
    const header = padded[0];
    const sep = `| ${header.map(() => '---').join(' | ')} |`;
    return truncate([toRow(header), sep, ...padded.slice(1).map(toRow)].join('\n'));
}

/**
 * DOCX → 段落文本（段落间 \n\n 分隔）。
 * 用 mammoth 提取：手写 <w:p>/<w:t> 正则读不到表格单元格内容，
 * mammoth 完整处理段落、表格、样式，且对缺 styles.xml 等残缺文件容错。
 * 缺 word/document.xml 时先经 fflate 预检（mammoth 对此抛错而非返回空）。
 */
async function extractDocx(data: Uint8Array): Promise<string> {
    const files = unzipSync(data);
    if (!files['word/document.xml']) return '（未找到文档正文）';
    const { value } = await mammoth.extractRawText({ buffer: data });
    const paragraphs = value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_ROWS);
    return truncate(paragraphs.length > 0 ? paragraphs.join('\n\n') : '（空文档）');
}

/** 纯文本 / 代码文件：按 UTF-8 读入并去掉 BOM，截断到字符预算 */
function extractPlainText(data: Uint8Array): string {
    const text = strFromU8(data).replace(/^\uFEFF/, '');
    return text.length === 0 ? '（空文件）' : truncate(text);
}

/**
 * 把 Excel / CSV / docx / 纯文本·代码 附件提取为文本/Markdown（供注入模型）。
 * CSV/xlsx/docx 分别交给 csv-parse / exceljs / mammoth 成熟库，本项目只负责渲染与截断。
 * 提取失败返回 null（上层注入一条「无法解析」说明，不中断对话）。
 */
export async function extractAttachmentText(
    mediaType: string,
    filename: string,
    data: Uint8Array
): Promise<string | null> {
    try {
        const lower = filename.toLowerCase();
        if (mediaType.includes('csv') || lower.endsWith('.csv')) return extractCsv(data);
        if (lower.endsWith('.xlsx') || mediaType.includes('spreadsheetml')) return await extractXlsx(data);
        if (lower.endsWith('.docx') || mediaType.includes('wordprocessingml')) return await extractDocx(data);
        if (isTextLike(filename, mediaType)) return extractPlainText(data);
        // .xls（旧二进制格式）不解析：fflate 只能解 zip（xlsx）
        return null;
    } catch (err) {
        log.warn('附件文本提取失败', { filename, mediaType, err: err instanceof Error ? err.message : err });
        return null;
    }
}
