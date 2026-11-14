import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { Alert, Button, Empty, Select, Spin, Tag } from 'antd';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchLogsApi, getLogExportUrl, type LogLevel, type LogRecord } from '@/services';
import dayjs from '@/utils/dayjs';

import useStyles from './styles';

const LEVEL_COLOR: Record<LogLevel, string> = {
    error: 'error',
    warn: 'warning',
    info: 'blue',
    debug: 'default'
};

/** 从日志记录里剥出附加字段（除标准字段外的），用于次要展示 */
const STANDARD_KEYS = new Set(['ts', 'level', 'module', 'requestId', 'msg']);
function extraFields(rec: LogRecord): string {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
        if (!STANDARD_KEYS.has(k)) rest[k] = v;
    }
    if (Object.keys(rest).length === 0) return '';
    try {
        return JSON.stringify(rest);
    } catch {
        return '';
    }
}

/**
 * 日志时间按查看者本地时区展示：当天记录为 HH:mm:ss.SSS，非当天记录带上日期 MM-DD HH:mm:ss.SSS。
 * 后端时间戳固定带 +08:00 偏移（见 backend logging/time.ts），是明确的绝对时刻，
 * dayjs 解析后按本地时区格式化，而不是直接截取字符串（那样恒等于北京时间、非本地时区）。
 * 带日期的原因：未开启落盘时后端仍会返回历史日志文件里的旧记录，只显示时分秒会被误认为是当前时间。
 */
function formatLogTime(ts?: string): string {
    if (!ts) return '';
    const d = dayjs(ts);
    if (!d.isValid()) return ts.slice(11, 23); // 解析失败兜底：退回原截取
    const sameYear = d.isSame(dayjs(), 'year');
    if (d.isSame(dayjs(), 'day')) return d.format('HH:mm:ss.SSS');
    return d.format(sameYear ? 'MM-DD HH:mm:ss.SSS' : 'YYYY-MM-DD HH:mm:ss.SSS');
}

/** 日志查看面板：按级别过滤查看近期后端日志、刷新、导出当天日志文件。 */
export function LogPanel() {
    const { styles, cx } = useStyles();

    // level 过滤直接通过 run(level) 触发请求，不额外维护 state
    const { data, loading, run, refresh } = useRequest(
        async (lvl?: LogLevel) => {
            const res = await fetchLogsApi({ level: lvl, limit: 500 });
            return res.code === SUCCESS_CODE ? res.data : undefined;
        },
        { manual: false }
    );

    const records = data?.records ?? [];
    const enabled = data?.enabled ?? true;

    return (
        <div className={cx('log-panel', styles.toString())}>
            <div className="log-panel-toolbar">
                <Select<LogLevel | 'all'>
                    size="small"
                    defaultValue="all"
                    style={{ width: 120 }}
                    onChange={(v) => run(v === 'all' ? undefined : v)}
                    options={[
                        { value: 'all', label: '全部级别' },
                        { value: 'error', label: 'error' },
                        { value: 'warn', label: 'warn 及以上' },
                        { value: 'info', label: 'info 及以上' },
                        { value: 'debug', label: 'debug（全部）' }
                    ]}
                />
                <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>
                    刷新
                </Button>
                <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    href={getLogExportUrl()}
                    target="_blank"
                    rel="noreferrer"
                >
                    导出当天日志
                </Button>
                <span className="log-panel-hint">最新 {records.length} 条</span>
            </div>

            {!enabled && (
                <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    title="当前未开启日志落盘"
                    description="开发模式默认仅输出到控制台。设置环境变量 LOG_TO_FILE=true 并重启后端后，日志会落盘到 ~/.zhuixun/logs 并可在此查看。"
                />
            )}

            <Spin spinning={loading}>
                {records.length === 0 ? (
                    <Empty description="暂无日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                    <div className="log-panel-list">
                        {records.map((rec, idx) => {
                            const extra = extraFields(rec);
                            return (
                                <div key={`${rec.ts}-${idx}`} className="log-panel-item">
                                    <span className="log-panel-time">{formatLogTime(rec.ts)}</span>
                                    <Tag color={LEVEL_COLOR[rec.level] ?? 'default'}>{rec.level}</Tag>
                                    {rec.module && <span className="log-panel-module">[{rec.module}]</span>}
                                    <span className="log-panel-msg">
                                        {rec.msg}
                                        {extra && <span className="log-panel-fields"> {extra}</span>}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </Spin>
        </div>
    );
}

export default LogPanel;
