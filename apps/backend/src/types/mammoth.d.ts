/**
 * mammoth 类型声明。
 *
 * npm 上无官方类型，@types/mammoth 亦不存在（DefinitelyTyped 未收录）。
 * 本项目只用 docx 文本/HTML 提取两条 API，声明到此为止；其余 API 按需补充。
 */
declare module 'mammoth' {
    /** extractRawText / convertToHtml 的统一返回。 */
    export interface MammothResult {
        value: string;
        messages: unknown[];
    }

    /** 从内存 buffer 提取 docx 纯文本（段落以换行分隔，表格单元格内容含在内）。 */
    export function extractRawText(input: { buffer: ArrayBuffer | Uint8Array }): Promise<MammothResult>;

    /** 从内存 buffer 把 docx 转换为 HTML。 */
    export function convertToHtml(input: { buffer: ArrayBuffer | Uint8Array }): Promise<MammothResult>;
}
