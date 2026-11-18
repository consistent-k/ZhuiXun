import { useRequest } from 'ahooks';
import { App, Button, Input, InputNumber, Radio, Spin, Switch } from 'antd';
import { useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchWebSettingsApi, testWebFetchApi, updateWebSettingsApi } from '@/services';
import type { WebSettingsView } from '@/services';

import useStyles from './styles';

/** 文本域 ↔ host 数组：按行拆分，去空白与空行。 */
function parseHosts(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Web 访问设置面板（本期仅 WebFetch）。
 *
 * 真源在后端 settings.json；面板维护一份草稿，点「保存」后以后端返回为准。
 * 搜索相关配置在 WebSearch 阶段再新增，这里不预留无效输入项。
 */
export function WebAccessPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [form, setForm] = useState<WebSettingsView | null>(null);
    // host 规则用独立的文本草稿：若直接由数组 join 回填，用户按下回车新增的空行会被立刻吃掉。
    const [allowedText, setAllowedText] = useState('');
    const [blockedText, setBlockedText] = useState('');
    const [saving, setSaving] = useState(false);
    const [testUrl, setTestUrl] = useState('');
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; detail: string; ms: number } | null>(null);

    const applyForm = (data: WebSettingsView) => {
        setForm(data);
        setAllowedText(data.allowedHosts.join('\n'));
        setBlockedText(data.blockedHosts.join('\n'));
    };

    const { loading } = useRequest(
        async () => {
            const res = await fetchWebSettingsApi();
            return res.code === SUCCESS_CODE ? res.data : undefined;
        },
        {
            onSuccess: (data) => {
                if (data) applyForm(data);
            }
        }
    );

    const patch = <K extends keyof WebSettingsView>(key: K, value: WebSettingsView[K]) => {
        setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    };

    const handleSave = async () => {
        if (!form) return;
        setSaving(true);
        try {
            const res = await updateWebSettingsApi({
                ...form,
                allowedHosts: parseHosts(allowedText),
                blockedHosts: parseHosts(blockedText)
            });
            if (res.code === SUCCESS_CODE && res.data) {
                applyForm(res.data);
                message.success('Web 访问设置已保存，下一轮对话生效');
            } else {
                message.error(res.message ?? '保存失败');
            }
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        const url = testUrl.trim();
        if (!url) {
            message.warning('请先填写要测试的 URL');
            return;
        }
        setTesting(true);
        setTestResult(null);
        try {
            const res = await testWebFetchApi(url);
            if (res.code === SUCCESS_CODE && res.data) {
                setTestResult(res.data);
                if (!res.data.ok) message.warning('抓取失败，请查看下方原因');
            } else {
                message.error(res.message ?? '测试失败');
            }
        } finally {
            setTesting(false);
        }
    };

    return (
        <Spin spinning={loading} className={cx('web-access-panel', styles.toString())}>
            {form && (
                <>
                    <div className="web-access-rows">
                        <div className="web-access-row">
                            <div>
                                <div className="web-access-title">开启 Web 访问</div>
                                <div className="web-access-hint">
                                    允许智能体读取用户给出的网页与在线文档。抓取的 URL
                                    与正文会发送给模型服务并写入会话记录。
                                </div>
                            </div>
                            <Switch checked={form.enabled} onChange={(checked) => patch('enabled', checked)} />
                        </div>

                        <div className="web-access-row">
                            <div>
                                <div className="web-access-title">允许读取网页（WebFetch）</div>
                                <div className="web-access-hint">
                                    只读、无本地副作用；仅支持 html / 纯文本 / markdown / json。
                                </div>
                            </div>
                            <Switch
                                checked={form.fetchEnabled}
                                disabled={!form.enabled}
                                onChange={(checked) => patch('fetchEnabled', checked)}
                            />
                        </div>

                        <div className="web-access-row">
                            <div>
                                <div className="web-access-title">每次调用都需确认</div>
                                <div className="web-access-hint">
                                    开启后 WebFetch 执行前会弹出确认卡片；默认自动放行。
                                </div>
                            </div>
                            <Radio.Group
                                value={form.requireApproval}
                                onChange={(event) => patch('requireApproval', event.target.value)}
                            >
                                <Radio value="never">自动放行</Radio>
                                <Radio value="always">每次确认</Radio>
                            </Radio.Group>
                        </div>
                    </div>

                    <div className="web-access-grid">
                        <label className="web-access-field">
                            <span className="web-access-field-label">超时（秒）</span>
                            <InputNumber
                                min={1}
                                max={60}
                                value={Math.round(form.timeoutMs / 1000)}
                                onChange={(value) => patch('timeoutMs', (value ?? 15) * 1000)}
                            />
                        </label>
                        <label className="web-access-field">
                            <span className="web-access-field-label">解压后完整响应上限（KiB）</span>
                            <InputNumber
                                min={64}
                                max={10 * 1024}
                                value={Math.round(form.maxBytes / 1024)}
                                // 清空时保留当前字节值，避免覆盖已保存值或经 KiB 换算丢失精度。
                                onChange={(value) => patch('maxBytes', value === null ? form.maxBytes : value * 1024)}
                            />
                            <span className="web-access-hint">
                                限制解压后的完整响应；先检查此上限，再提取正文并按返回正文上限（maxChars）截断。
                            </span>
                        </label>
                        <label className="web-access-field">
                            <span className="web-access-field-label">返回正文上限（字符）</span>
                            <InputNumber
                                min={1000}
                                max={100_000}
                                step={1000}
                                value={form.maxChars}
                                onChange={(value) => patch('maxChars', value ?? 20_000)}
                            />
                        </label>
                    </div>

                    <div className="web-access-columns">
                        <label className="web-access-field">
                            <span className="web-access-field-label">可信代理（留空直连）</span>
                            <Input
                                placeholder="http://127.0.0.1:7890"
                                value={form.proxyUrl}
                                onChange={(event) => patch('proxyUrl', event.target.value)}
                            />
                            <span className="web-access-hint">
                                填写 HTTP(S) 代理地址。代理负责解析目标，仅连接允许列表中逐一填写的 HTTPS 域名。
                            </span>
                        </label>
                    </div>

                    <div className="web-access-columns">
                        <label className="web-access-field">
                            <span className="web-access-field-label">允许的域名（留空表示不限制）</span>
                            <Input.TextArea
                                rows={4}
                                placeholder={'example.com\n*.wikipedia.org'}
                                value={allowedText}
                                onChange={(event) => setAllowedText(event.target.value)}
                            />
                        </label>
                        <label className="web-access-field">
                            <span className="web-access-field-label">禁止的域名（优先于允许列表）</span>
                            <Input.TextArea
                                rows={4}
                                placeholder={'internal.example.com'}
                                value={blockedText}
                                onChange={(event) => setBlockedText(event.target.value)}
                            />
                        </label>
                    </div>
                    <div className="web-access-hint web-access-hint--block">
                        规则按行填写，支持 `example.com` 与
                        `*.example.com`。直连时拦截解析到非公网地址的域名。代理模式由可信代理负责目标解析。
                    </div>

                    <div className="web-access-actions">
                        <Button type="primary" loading={saving} onClick={handleSave}>
                            保存
                        </Button>
                    </div>

                    <div className="web-access-test">
                        <div className="web-access-title">连通性测试</div>
                        <div className="web-access-hint">
                            使用当前允许 / 禁止规则发起一次真实抓取，仅返回标题与正文长度。
                        </div>
                        <div className="web-access-test-row">
                            <Input
                                placeholder="https://example.com"
                                value={testUrl}
                                onChange={(event) => setTestUrl(event.target.value)}
                                onPressEnter={handleTest}
                            />
                            <Button loading={testing} onClick={handleTest}>
                                测试
                            </Button>
                        </div>
                        {testResult && (
                            <div
                                className={
                                    testResult.ok
                                        ? 'web-access-test-result web-access-test-result--ok'
                                        : 'web-access-test-result web-access-test-result--error'
                                }
                            >
                                {testResult.ok ? '抓取成功' : '抓取失败'} · {testResult.ms}ms · {testResult.detail}
                            </div>
                        )}
                    </div>
                </>
            )}
        </Spin>
    );
}
