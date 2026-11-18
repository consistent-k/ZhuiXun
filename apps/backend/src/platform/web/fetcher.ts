import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import { createLogger } from '@/platform/logging/index';

import {
    WebAccessError,
    parseAndValidateUrl,
    resolvePublicAddress,
    type HostPolicy,
    type PinnedAddress
} from './url-policy';

const log = createLogger('WebFetch');

/** 单次抓取的策略（由 settings 映射而来）。 */
export interface FetchPolicy extends HostPolicy {
    timeoutMs: number;
    maxBytes: number;
    proxyUrl?: string;
}

export interface RawResponse {
    status: number;
    statusText: string;
    location?: string;
    /** 最终请求的 URL（跟随重定向后的当前地址）。 */
    finalUrl: string;
    mime: string;
    charset?: string;
    body: Buffer;
    bytesRead: number;
}

const MAX_REDIRECTS = 5;
/** 压缩体读取上限 = 解压上限的 4 倍；防压缩炸弹同时容忍正常 gzip 膨胀。 */
const RAW_BYTES_FACTOR = 4;
/** 并发抓取上限：避免一次 fan-out 打爆对端。 */
const MAX_CONCURRENT = 4;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const ALLOWED_MIME = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json']);

const USER_AGENT = 'zhuixun-WebFetch/1.0 (+https://zhuixun.local)';

// ---------------------------------------------------------------------------
// 并发信号量
// ---------------------------------------------------------------------------

let activeRequests = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (activeRequests >= MAX_CONCURRENT) {
        await new Promise<void>((resolve) => waiters.push(resolve));
    }
    activeRequests += 1;
    try {
        return await task();
    } finally {
        activeRequests -= 1;
        const next = waiters.shift();
        if (next) next();
    }
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

function parseContentType(raw: string | string[] | undefined): { mime: string; charset?: string } {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return { mime: '' };
    const [mimeRaw, ...params] = value.split(';');
    const mime = mimeRaw.trim().toLowerCase();
    const charsetParam = params.find((p) => p.trim().toLowerCase().startsWith('charset='));
    const charset = charsetParam?.split('=')[1]?.trim().replace(/^"|"$/g, '');
    return { mime, charset: charset || undefined };
}

/** 按 Content-Encoding 解压，并限制解压后体积（防压缩炸弹）。 */
function decompressBody(body: Buffer, encoding: string | string[] | undefined, maxBytes: number): Buffer {
    const enc = (Array.isArray(encoding) ? encoding[0] : (encoding ?? '')).trim().toLowerCase();
    if (!enc || enc === 'identity') return body;

    const options = { maxOutputLength: maxBytes };
    try {
        if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(body, options);
        if (enc === 'deflate') return inflateSync(body, options);
        if (enc === 'br') return brotliDecompressSync(body, options);
        // 未知编码按原样返回，交给解码层处理
        return body;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
            throw new WebAccessError('TOO_LARGE', `响应解压后超过 ${Math.round(maxBytes / 1024)}KB 上限`);
        }
        // 已声明的压缩格式损坏时不能把原始字节当正文成功返回；统一错误文案，超限仍保留 TOO_LARGE。
        log.warn('响应解压失败', { encoding: enc, err: error });
        throw new WebAccessError('NETWORK_ERROR', '响应解压失败');
    }
}

function nodeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 把 Node 网络错误映射为稳定的工具错误码。 */
function mapNodeError(error: unknown): WebAccessError {
    if (error instanceof WebAccessError) return error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new WebAccessError('DNS_FAILED', `域名解析失败：${nodeErrorMessage(error)}`);
    }
    if (code === 'ETIMEDOUT') {
        return new WebAccessError('TIMEOUT', '连接目标超时');
    }
    return new WebAccessError('NETWORK_ERROR', `网络请求失败：${nodeErrorMessage(error)}`);
}

/**
 * 发起单跳请求。使用自定义 lookup 把连接钉在已校验的 IP 上，防 DNS rebinding：
 * Host / SNI 仍用原域名，实际 TCP 目标是 resolvePublicAddress 返回的地址。
 */
function performRequest(
    url: URL,
    connection: { pinned: PinnedAddress } | { proxyAgent: https.Agent },
    policy: FetchPolicy,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<RawResponse> {
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise<RawResponse>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        const cleanup = (): void => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = (action: () => void): void => {
            if (settled) return;
            settled = true;
            cleanup();
            action();
        };

        let request: http.ClientRequest;

        const onAbort = (): void => {
            request.destroy(new WebAccessError('NETWORK_ERROR', '请求已取消'));
        };

        const safeLookup = (
            _hostname: string,
            options: { all?: boolean },
            callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void
        ): void => {
            if (!('pinned' in connection)) throw new Error('直连请求缺少已校验的地址');
            const { pinned } = connection;
            if (options?.all) {
                callback(null, [{ address: pinned.address, family: pinned.family }]);
                return;
            }
            callback(null, pinned.address, pinned.family);
        };

        try {
            request = transport.request(
                url,
                {
                    method: 'GET',
                    headers: {
                        'User-Agent': USER_AGENT,
                        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br'
                    },
                    ...('proxyAgent' in connection
                        ? { agent: connection.proxyAgent }
                        : { agent: false as const, lookup: safeLookup as unknown as http.RequestOptions['lookup'] })
                },
                (response) => {
                    const status = response.statusCode ?? 0;
                    const statusText = response.statusMessage ?? '';
                    const { mime, charset } = parseContentType(response.headers['content-type']);

                    // 重定向：不读取正文，交给上层逐跳重新校验
                    if (REDIRECT_STATUS.has(status)) {
                        const locationHeader = response.headers.location;
                        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
                        response.resume();
                        finish(() =>
                            resolve({
                                status,
                                statusText,
                                location,
                                finalUrl: url.toString(),
                                mime,
                                charset,
                                body: Buffer.alloc(0),
                                bytesRead: 0
                            })
                        );
                        return;
                    }

                    // 非 2xx：不读取正文，由上层抛 HTTP_ERROR
                    if (status < 200 || status >= 300) {
                        response.resume();
                        finish(() =>
                            resolve({
                                status,
                                statusText,
                                finalUrl: url.toString(),
                                mime,
                                charset,
                                body: Buffer.alloc(0),
                                bytesRead: 0
                            })
                        );
                        return;
                    }

                    const declaredLength = Number(response.headers['content-length'] ?? 0);
                    const rawCap = policy.maxBytes * RAW_BYTES_FACTOR;
                    if (Number.isFinite(declaredLength) && declaredLength > rawCap) {
                        response.destroy();
                        finish(() =>
                            reject(
                                new WebAccessError(
                                    'TOO_LARGE',
                                    `响应体超过 ${Math.round(policy.maxBytes / 1024)}KB 上限`
                                )
                            )
                        );
                        return;
                    }

                    const chunks: Buffer[] = [];
                    let received = 0;
                    response.on('data', (chunk: Buffer) => {
                        received += chunk.length;
                        if (received > rawCap) {
                            response.destroy();
                            finish(() =>
                                reject(
                                    new WebAccessError(
                                        'TOO_LARGE',
                                        `响应体超过 ${Math.round(policy.maxBytes / 1024)}KB 上限`
                                    )
                                )
                            );
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.on('error', (error) => finish(() => reject(mapNodeError(error))));
                    response.on('end', () => {
                        try {
                            const raw = Buffer.concat(chunks);
                            const body = decompressBody(raw, response.headers['content-encoding'], policy.maxBytes);
                            if (body.length > policy.maxBytes) {
                                finish(() =>
                                    reject(
                                        new WebAccessError(
                                            'TOO_LARGE',
                                            `响应体超过 ${Math.round(policy.maxBytes / 1024)}KB 上限`
                                        )
                                    )
                                );
                                return;
                            }
                            finish(() =>
                                resolve({
                                    status,
                                    statusText,
                                    finalUrl: url.toString(),
                                    mime,
                                    charset,
                                    body,
                                    bytesRead: body.length
                                })
                            );
                        } catch (error) {
                            finish(() => reject(mapNodeError(error)));
                        }
                    });
                }
            );
        } catch (error) {
            finish(() => reject(mapNodeError(error)));
            return;
        }

        request.on('error', (error) => finish(() => reject(mapNodeError(error))));
        // 总时长封顶：setTimeout 只是空闲超时，响应持续滴流时不会触发
        timer = setTimeout(() => {
            request.destroy(new WebAccessError('TIMEOUT', `抓取超时（${timeoutMs}ms）`));
        }, timeoutMs);

        if (signal) {
            if (signal.aborted) {
                request.destroy(new WebAccessError('NETWORK_ERROR', '请求已取消'));
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }

        request.end();
    });
}

/**
 * 受控抓取入口：校验起始 URL → 逐跳解析并钉 IP → 跟随重定向 → 返回原始响应。
 *
 * 注意：每一跳都重新执行 `parseAndValidateUrl` + `resolvePublicAddress`，
 * 不能只在起始 URL 校验一次（否则 `https://public.example` 302 到 `http://127.0.0.1`
 * 就能绕过全部防护）。
 */
export async function requestUrl(rawUrl: string, policy: FetchPolicy, signal?: AbortSignal): Promise<RawResponse> {
    const deadline = Date.now() + policy.timeoutMs;
    const proxyUrl = policy.proxyUrl;
    // 代理负责解析目标，客户端无法核验最终地址。只允许用户逐一列出的 HTTPS 域名，重定向也受此约束。
    const proxyHosts = proxyUrl ? policy.allowedHosts.filter((host) => !host.includes('*')) : undefined;
    if (proxyHosts?.length === 0) {
        throw new WebAccessError('BLOCKED_HOST', '使用代理时，请先在允许列表中填写具体目标域名');
    }
    const hostPolicy = proxyHosts ? { ...policy, allowedHosts: proxyHosts } : policy;
    let current = parseAndValidateUrl(rawUrl, hostPolicy);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await withSlot(async () => {
            const remaining = () => {
                const ms = deadline - Date.now();
                if (ms <= 0) throw new WebAccessError('TIMEOUT', `抓取超时（${policy.timeoutMs}ms）`);
                return ms;
            };
            remaining();
            if (!proxyUrl) {
                const pinned = await resolvePublicAddress(current.hostname);
                return performRequest(current, { pinned }, policy, remaining(), signal);
            }
            if (current.protocol !== 'https:' || current.port) {
                throw new WebAccessError('INVALID_URL', '代理模式仅支持 HTTPS 443 端口');
            }
            const [major, minor] = process.versions.node.split('.').map(Number);
            if (major === 24 && minor < 5) {
                throw new WebAccessError('NETWORK_ERROR', 'WebFetch 代理需要 Node.js 24.5 或更高版本');
            }
            const proxyAgent = new https.Agent({ proxyEnv: { HTTPS_PROXY: proxyUrl } });
            try {
                return await performRequest(current, { proxyAgent }, policy, remaining(), signal);
            } finally {
                proxyAgent.destroy();
            }
        });

        if (REDIRECT_STATUS.has(response.status)) {
            if (!response.location) {
                throw new WebAccessError('HTTP_ERROR', `目标返回 ${response.status} 但缺少 Location`, response.status);
            }
            if (hop === MAX_REDIRECTS) {
                throw new WebAccessError('HTTP_ERROR', `重定向次数超过 ${MAX_REDIRECTS} 次`, response.status);
            }
            const next = new URL(response.location, current);
            current = parseAndValidateUrl(next.toString(), hostPolicy);
            continue;
        }

        if (response.status < 200 || response.status >= 300) {
            throw new WebAccessError(
                'HTTP_ERROR',
                `目标返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
                response.status
            );
        }

        if (response.mime && !ALLOWED_MIME.has(response.mime)) {
            throw new WebAccessError(
                'UNSUPPORTED_CONTENT_TYPE',
                `不支持的内容类型：${response.mime}（支持 html / 纯文本 / markdown / json）`
            );
        }

        return response;
    }

    throw new WebAccessError('HTTP_ERROR', `重定向次数超过 ${MAX_REDIRECTS} 次`);
}
