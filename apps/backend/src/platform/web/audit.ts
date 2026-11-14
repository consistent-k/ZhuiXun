import fsp from 'node:fs/promises';

import dayjs from 'dayjs';

import { paths } from '@/config/paths';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('WebAudit');

/** 查询串里的敏感参数：值替换为 `***`，避免把 token / 签名写进审计文件。 */
const SENSITIVE_PARAM = /^(token|access_token|key|api_key|apikey|sig|signature|password|passwd|secret|code|auth)$/i;

/** 打码 URL 的敏感查询参数；非法 URL 原样返回。 */
export function maskUrl(raw: string): string {
    try {
        const url = new URL(raw);
        for (const key of [...url.searchParams.keys()]) {
            if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, '***');
        }
        return url.toString();
    } catch {
        return raw;
    }
}

function hostOf(raw: string): string {
    try {
        return new URL(raw).host;
    } catch {
        return '';
    }
}

export interface WebAuditEntry {
    tool: 'WebFetch';
    url: string;
    host?: string;
    /** HTTP 状态码（成功或 HTTP_ERROR 时）。 */
    status?: number;
    /** 实际读取的字节数（解压后）。 */
    bytes?: number;
    /** 耗时（毫秒）。 */
    ms: number;
    ok: boolean;
    errorCode?: string;
    truncated?: boolean;
}

/**
 * 追加写 Web 审计。与 shell 审计同样串行化，写失败只告警——
 * 审计不该让模型的一次抓取失败。
 */
let auditChain: Promise<void> = Promise.resolve();
let auditDirReady: Promise<void> | undefined;

export function recordWebAudit(entry: WebAuditEntry): void {
    const record = {
        ts: dayjs().toISOString(),
        ...entry,
        url: maskUrl(entry.url),
        host: entry.host ?? hostOf(entry.url)
    };
    const line = `${JSON.stringify(record)}\n`;

    auditChain = auditChain
        .then(async () => {
            auditDirReady ??= fsp.mkdir(paths.auditDir(), { recursive: true }).then(() => undefined);
            await auditDirReady;
            await fsp.appendFile(paths.webAuditFile(), line, 'utf8');
        })
        .catch((error: unknown) => {
            log.warn('Web 审计写入失败', { err: error });
        });
}
