import request, { API_BASE_URL, type BaseResponse } from '@/utils/request';

/** 日志级别 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** 一条日志记录（后端 NDJSON，字段按需透出） */
export interface LogRecord {
    ts: string;
    level: LogLevel;
    module?: string;
    requestId?: string;
    msg: string;
    [key: string]: unknown;
}

/** 日志查询结果：是否已开启落盘 + 记录列表（最新优先） */
export interface LogsResult {
    enabled: boolean;
    records: LogRecord[];
}

/** 查询近期后端日志（最新优先）。level 为最低级别过滤。 */
export function fetchLogsApi(params?: {
    level?: LogLevel;
    limit?: number;
    since?: number;
}): Promise<BaseResponse<LogsResult>> {
    return request.get('/api/logs', { params });
}

/** 当天日志文件下载 URL（原始 NDJSON） */
export function getLogExportUrl(): string {
    return `${API_BASE_URL}/api/logs/export`;
}
