import { Alert, Flex, Form, Input, QRCode, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';

import Modal from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { startChannelQrApi, pollChannelQrApi, type ChannelItem } from '@/services';

interface ChannelBindModalProps {
    channel: ChannelItem | null;
    onCancel: () => void;
    /** Token 表单绑定（Telegram）：提交 payload 交由父组件调用 bindChannelApi */
    onTokenSubmit: (payload: Record<string, string>) => Promise<void>;
    /** 扫码绑定成功（微信）：父组件负责关闭 + 刷新列表 */
    onSuccess: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 渠道绑定弹窗：
 * - Telegram（supportsBind）：填 Bot Token 表单绑定。
 * - 微信（supportsQr）：扫码绑定——拉二维码内容 → antd QRCode 渲染 → 轮询扫码状态直到 connected。
 */
export function ChannelBindModal({ channel, onCancel, onTokenSubmit, onSuccess }: ChannelBindModalProps) {
    const [form] = Form.useForm();
    const [submitting, setSubmitting] = useState(false);
    const [qrUrl, setQrUrl] = useState('');
    const [qrMsg, setQrMsg] = useState('');
    const [qrLoading, setQrLoading] = useState(false);

    const isQr = !!channel && channel.supportsQr && !channel.supportsBind;

    // onSuccess 用 ref 持有，避免进轮询 effect 的依赖导致重连
    const onSuccessRef = useRef(onSuccess);
    useEffect(() => {
        onSuccessRef.current = onSuccess;
    });

    useEffect(() => {
        if (channel && !isQr) form.resetFields();
    }, [channel, isQr, form]);

    // 扫码流程：拉二维码 → 轮询状态。channel 关闭或切换即停止。
    useEffect(() => {
        if (!channel || !isQr) return;
        let stopped = false;

        const run = async () => {
            setQrUrl('');
            setQrLoading(true);
            setQrMsg('正在获取二维码…');
            const res = await startChannelQrApi(channel.id);
            setQrLoading(false);
            if (res.code !== SUCCESS_CODE || !res.data?.qrcodeUrl) {
                setQrMsg(res.data?.message || '获取二维码失败，请重试');
                return;
            }
            const { sessionKey, qrcodeUrl, message } = res.data;
            setQrUrl(qrcodeUrl);
            setQrMsg(message);

            while (!stopped) {
                const st = await pollChannelQrApi(channel.id, sessionKey);
                if (stopped) break;
                if (st.code !== SUCCESS_CODE || !st.data) {
                    await sleep(2000);
                    continue;
                }
                setQrMsg(st.data.message);
                if (st.data.connected) {
                    onSuccessRef.current();
                    break;
                }
                // 终态（过期/失败/已绑定）停止轮询，由用户重开弹窗再拉新码
                if (/过期|失败|已绑定|不存在/.test(st.data.message)) break;
                await sleep(1200);
            }
        };
        void run();

        return () => {
            stopped = true;
        };
    }, [channel, isQr]);

    const handleOk = async () => {
        const values = await form.validateFields();
        setSubmitting(true);
        try {
            await onTokenSubmit(values as Record<string, string>);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            title={`绑定 ${channel?.name ?? ''}`}
            open={!!channel}
            onCancel={onCancel}
            {...(isQr
                ? { footer: null }
                : { onOk: handleOk, confirmLoading: submitting, okText: '绑定', cancelText: '取消' })}
        >
            {isQr ? (
                <div style={{ textAlign: 'center' }}>
                    <Alert
                        style={{ marginBottom: 16, textAlign: 'left' }}
                        type="warning"
                        showIcon
                        title="个人微信第三方协议"
                        description="存在封号 / 数据合规 / 敏感数据出域风险，请确认已通过合规评审后再绑定与启动。"
                    />
                    <Spin spinning={qrLoading}>
                        <Flex align="center" justify="center">
                            {qrUrl ? (
                                <QRCode value={qrUrl} size={200} />
                            ) : (
                                <div style={{ height: 200, lineHeight: '200px', color: '#999' }}>二维码加载中…</div>
                            )}
                        </Flex>
                    </Spin>
                    <div style={{ marginTop: 12, color: '#666' }}>{qrMsg || '用手机微信扫描二维码以连接'}</div>
                </div>
            ) : (
                <Form form={form} layout="vertical">
                    <Alert
                        style={{ marginBottom: 16 }}
                        type="info"
                        showIcon
                        title="获取 Bot Token"
                        description="在 Telegram 中搜索 @BotFather，发送 /newbot 创建机器人，复制其返回的 Token 填入下方。"
                    />
                    <Form.Item name="token" label="Bot Token" rules={[{ required: true, message: '请输入 Bot Token' }]}>
                        <Input.Password placeholder="123456:ABC-DEF..." />
                    </Form.Item>
                </Form>
            )}
        </Modal>
    );
}

export default ChannelBindModal;
