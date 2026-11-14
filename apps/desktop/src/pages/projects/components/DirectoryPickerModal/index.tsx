import { FolderOutlined, HomeOutlined, VerticalAlignTopOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { Button, Empty, Spin } from 'antd';
import { useState } from 'react';

import Modal from '@/components/Modal';
import { SUCCESS_CODE } from '@/constant/code';
import { browseDirApi } from '@/services';

import useStyles from './styles';

interface DirectoryPickerModalProps {
    open: boolean;
    /** 打开时的初始目录（缺省则从后端主目录开始） */
    initialPath?: string;
    onSelect: (path: string) => void;
    onClose: () => void;
}

interface BrowserProps {
    initialPath?: string;
    onSelect: (path: string) => void;
    onCancel: () => void;
}

/**
 * 目录浏览主体。独立成组件、由 Modal 的 destroyOnHidden 控制挂载，
 * 这样每次打开都以最新 initialPath 重新初始化 state，无需在 effect 里 setState。
 */
function Browser({ initialPath, onSelect, onCancel }: BrowserProps) {
    const { styles, cx } = useStyles();
    // 当前请求的目录；undefined 时后端返回主目录
    const [current, setCurrent] = useState<string | undefined>(initialPath);

    const { data, loading } = useRequest(
        async () => {
            const res = await browseDirApi(current);
            return res.code === SUCCESS_CODE && res.data ? res.data : null;
        },
        { refreshDeps: [current] }
    );

    return (
        <div className={cx('dir-picker', styles.toString())}>
            <div className="dir-picker-toolbar">
                <Button size="small" icon={<HomeOutlined />} onClick={() => setCurrent(data?.home)} disabled={loading}>
                    主目录
                </Button>
                <Button
                    size="small"
                    icon={<VerticalAlignTopOutlined />}
                    onClick={() => data?.parent && setCurrent(data.parent)}
                    disabled={loading || !data?.parent}
                >
                    上级
                </Button>
                <span className="dir-picker-current" title={data?.path}>
                    {data?.path ?? '加载中…'}
                </span>
            </div>
            <Spin spinning={loading}>
                <div className="dir-picker-list">
                    {data && data.entries.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该目录下没有子文件夹" />
                    ) : (
                        data?.entries.map((e) => (
                            <div key={e.path} className="dir-picker-item" onClick={() => setCurrent(e.path)}>
                                <FolderOutlined />
                                <span className="dir-picker-item-name">{e.name}</span>
                            </div>
                        ))
                    )}
                </div>
            </Spin>
            <div className="dir-picker-footer">
                <Button onClick={onCancel}>取消</Button>
                <Button type="primary" disabled={!data} onClick={() => data && onSelect(data.path)}>
                    选择当前目录
                </Button>
            </div>
        </div>
    );
}

/**
 * 目录选择弹窗：浏览的是**后端主机**的文件系统（通过 /api/projects/browse-dir），
 * 因此浏览器端与桌面端行为一致，选出的路径就是后端可用的绝对路径。
 */
export function DirectoryPickerModal({ open, initialPath, onSelect, onClose }: DirectoryPickerModalProps) {
    return (
        <Modal title="选择工作目录" open={open} onCancel={onClose} footer={null}>
            {open && <Browser initialPath={initialPath} onSelect={onSelect} onCancel={onClose} />}
        </Modal>
    );
}
