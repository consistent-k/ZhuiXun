import { DownOutlined, SafetyCertificateOutlined, WarningFilled } from '@ant-design/icons';
import type { ApprovalMode } from '@zhuixun/shared';
import { App, Button, Dropdown, Tag } from 'antd';
import { useState } from 'react';

import { useChatStore } from '@/stores';
import { desktopApprovalBridge } from '@/utils/request';

const modes: { key: ApprovalMode; label: string; description: string }[] = [
    { key: 'ask', label: '请求批准', description: '需要授权时询问你' },
    { key: 'auto-review', label: '帮我批准', description: '自动批准可核验的可信项目内编辑' },
    { key: 'full-access', label: '完全访问权限', description: '跳过可跳过的工具审批' }
];

export function ApprovalModePicker({ disabled, dangerMode }: { disabled?: boolean; dangerMode: boolean }) {
    const id = useChatStore((state) => state.currentConversationId);
    const mode = useChatStore((state) => (id ? state.approvalById[id]?.mode : undefined) ?? 'ask');
    const [confirming, setConfirming] = useState(false);
    const { message } = App.useApp();
    const bridge = desktopApprovalBridge();

    async function select(key: string) {
        if (!id || key === mode) return;
        if (key === 'ask' || key === 'auto-review') {
            useChatStore.getState().setApproval(id, { mode: key });
        } else if (key === 'full-access' && bridge) {
            setConfirming(true);
            try {
                const grant = await bridge.grant(id);
                if (grant) useChatStore.getState().setApproval(id, { mode: key, grant });
            } catch {
                message.error('无法启用完全访问权限，请重试');
            } finally {
                setConfirming(false);
            }
        }
    }

    if (dangerMode) {
        return (
            <Tag color="error" icon={<WarningFilled />}>
                启动参数已启用危险审批模式
            </Tag>
        );
    }

    return (
        <Dropdown
            trigger={['click']}
            disabled={disabled || confirming || !id}
            menu={{
                selectable: true,
                selectedKeys: [mode],
                items: modes.map(({ key, label, description }) => ({
                    key,
                    disabled: key === 'full-access' && !bridge,
                    label: (
                        <div>
                            <div>{label}</div>
                            <small>{key === 'full-access' && !bridge ? '需要连接桌面应用内置后端' : description}</small>
                        </div>
                    )
                })),
                onClick: ({ key }) => void select(key)
            }}
        >
            <Button
                size="small"
                type="text"
                danger={mode === 'full-access'}
                loading={confirming}
                disabled={disabled || !id}
                icon={mode === 'full-access' ? <WarningFilled /> : <SafetyCertificateOutlined />}
                aria-label={`审批模式：${modes.find((item) => item.key === mode)?.label}`}
                aria-haspopup="menu"
            >
                {modes.find((item) => item.key === mode)?.label} <DownOutlined />
            </Button>
        </Dropdown>
    );
}
