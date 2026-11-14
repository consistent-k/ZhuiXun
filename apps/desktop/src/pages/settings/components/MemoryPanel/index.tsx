import { useRequest } from 'ahooks';
import { App, Button, Spin, Switch } from 'antd';
import { useState } from 'react';

import MemoryItems from '@/components/MemoryItems';
import { SUCCESS_CODE } from '@/constant/code';
import { fetchMemoryApi, patchMemoryApi, triggerMemoryDreamApi } from '@/services';

import useStyles from './styles';

export function MemoryPanel() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    const [enabled, setEnabled] = useState(true);
    const [autoExtract, setAutoExtract] = useState(true);
    const [autoDream, setAutoDream] = useState(true);
    const [dreaming, setDreaming] = useState(false);

    // 仅拉全局维度的开关状态（enabled/autoExtract/autoDream 是全局设置，不分 scope）
    const { loading } = useRequest(
        async () => {
            const res = await fetchMemoryApi({ scope: 'global' });
            return res.code === SUCCESS_CODE ? res.data : undefined;
        },
        {
            onSuccess: (d) => {
                if (d) {
                    setEnabled(d.enabled);
                    setAutoExtract(d.autoExtract);
                    setAutoDream(d.autoDream);
                }
            }
        }
    );

    const handleToggle = async (checked: boolean) => {
        setEnabled(checked);
        const res = await patchMemoryApi({ enabled: checked });
        if (res.code === SUCCESS_CODE) message.success(checked ? '记忆已开启' : '记忆已关闭');
        else setEnabled(!checked);
    };

    const handleAutoExtract = async (checked: boolean) => {
        setAutoExtract(checked);
        const res = await patchMemoryApi({ autoExtract: checked });
        if (res.code !== SUCCESS_CODE) setAutoExtract(!checked);
    };

    const handleAutoDream = async (checked: boolean) => {
        setAutoDream(checked);
        const res = await patchMemoryApi({ autoDream: checked });
        if (res.code !== SUCCESS_CODE) setAutoDream(!checked);
    };

    const handleDream = async () => {
        setDreaming(true);
        try {
            const res = await triggerMemoryDreamApi();
            if (res.code === SUCCESS_CODE) message.success('已触发整理，稍后刷新查看');
        } finally {
            setDreaming(false);
        }
    };

    return (
        <Spin spinning={loading} className={cx('memory-panel', styles.toString())}>
            <div className="memory-panel-row">
                <div>
                    <div className="memory-panel-title">开启记忆</div>
                    <div className="memory-panel-hint">开启后，相关记忆会在每轮对话中按需提供给智能体。</div>
                </div>
                <Switch checked={enabled} onChange={handleToggle} />
            </div>
            <div className="memory-panel-hint memory-panel-hint--block">
                这里管理「全局画像」记忆；项目专属记忆请到对应项目的设置页管理。请勿存放敏感个人隐私信息。
            </div>

            <div className="memory-panel-autorow">
                <span className="memory-panel-auto-item">
                    <Switch size="small" checked={autoExtract} disabled={!enabled} onChange={handleAutoExtract} />
                    自动沉淀（每轮对话后）
                </span>
                <span className="memory-panel-auto-item">
                    <Switch size="small" checked={autoDream} disabled={!enabled} onChange={handleAutoDream} />
                    自动整理（周期去重）
                </span>
                <Button size="small" loading={dreaming} disabled={!enabled} onClick={handleDream}>
                    立即整理
                </Button>
            </div>

            <div className="memory-panel-items">
                <MemoryItems scope="global" />
            </div>
        </Spin>
    );
}

export default MemoryPanel;
