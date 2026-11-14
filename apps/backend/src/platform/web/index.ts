import dayjs from 'dayjs';

import { recordWebAudit } from './audit';
import { extractPage, truncateMiddle } from './extract';
import { requestUrl, type FetchPolicy } from './fetcher';
import { WebAccessError } from './url-policy';

export { WebAccessError } from './url-policy';
export type { WebErrorCode, HostPolicy } from './url-policy';

export interface FetchPageOptions extends FetchPolicy {
    /** 返回给模型的正文最大字符数。 */
    maxChars: number;
    /** 调用方取消（如本轮对话被中断）。 */
    signal?: AbortSignal;
}

export interface ReadablePage {
    /** 请求的原始 URL。 */
    url: string;
    /** 跟随重定向后的最终 URL。 */
    finalUrl: string;
    title?: string;
    /** 归一化后的 MIME（可能是空串：目标站未返回 Content-Type）。 */
    contentType: string;
    /** Markdown 正文，已按 maxChars 截断。 */
    content: string;
    truncated: boolean;
    /** 解压后的实际读取字节数。 */
    bytesRead: number;
    fetchedAt: string;
}

/**
 * 受控抓取 + 正文抽取 + 审计的唯一入口。
 *
 * 策略（超时 / 体积 / host 黑白名单）由调用方从 settings 映射后传入，
 * 本模块不直接读配置，便于设置页连通性测试复用同一套逻辑。
 */
export async function fetchReadablePage(rawUrl: string, options: FetchPageOptions): Promise<ReadablePage> {
    const startedAt = Date.now();
    try {
        const response = await requestUrl(rawUrl, options, options.signal);
        const extracted = extractPage(response.body, {
            mime: response.mime,
            charset: response.charset,
            maxChars: options.maxChars
        });
        // HTTP 成功不代表有可读正文；抽取后只判空，避免误伤短文本及 JSON null / []，并走统一失败审计。
        if (!extracted.content.trim()) {
            throw new WebAccessError('EMPTY_CONTENT', '未抽取到可读正文');
        }
        const { content, truncated } = truncateMiddle(extracted.content, options.maxChars);

        recordWebAudit({
            tool: 'WebFetch',
            url: rawUrl,
            status: response.status,
            bytes: response.bytesRead,
            ms: Date.now() - startedAt,
            ok: true,
            truncated
        });

        return {
            url: rawUrl,
            finalUrl: response.finalUrl,
            title: extracted.title,
            contentType: response.mime,
            content,
            truncated,
            bytesRead: response.bytesRead,
            fetchedAt: dayjs().toISOString()
        };
    } catch (error) {
        const accessError =
            error instanceof WebAccessError
                ? error
                : new WebAccessError('NETWORK_ERROR', error instanceof Error ? error.message : String(error));
        recordWebAudit({
            tool: 'WebFetch',
            url: rawUrl,
            status: accessError.status,
            ms: Date.now() - startedAt,
            ok: false,
            errorCode: accessError.code
        });
        throw accessError;
    }
}
