import { DeleteOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Empty, Popconfirm, Spin, Switch, Tag } from 'antd';

import { SUCCESS_CODE } from '@/constant/code';
import { deletePermissionApi, fetchPermissionsApi, setAutoApprovalApi } from '@/services';
import dayjs from '@/utils/dayjs';

import useStyles from './styles';

/** 「已记住的授权」：Bash 免确认的自动放行总开关与已记住的永久命令头 / 写入目录规则。 */
export function RememberedRules() {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();

    // 挂载即拉取权限数据；loading / data 交给 useRequest，删除与开关走 mutate 乐观更新
    const { data, loading, mutate, refresh } = useRequest(async () => {
        const res = await fetchPermissionsApi();
        return res.code === SUCCESS_CODE ? res.data : undefined;
    });

    const enabled = data?.autoApprovalEnabled ?? true;
    const bashRules = data?.bash.allow ?? [];
    const writeRules = data?.write.allow ?? [];

    const handleToggle = async (checked: boolean) => {
        mutate((prev) => (prev ? { ...prev, autoApprovalEnabled: checked } : prev));
        const res = await setAutoApprovalApi(checked);
        if (res.code === SUCCESS_CODE && res.data) {
            mutate(res.data);
            message.success(checked ? '已开启自动放行' : '已关闭自动放行');
        } else {
            // 失败回滚（错误提示已由 request 拦截器统一弹出）
            refresh();
        }
    };

    const handleDelete = async (id: string) => {
        mutate((prev) =>
            prev
                ? {
                      ...prev,
                      bash: { allow: prev.bash.allow.filter((r) => r.id !== id) },
                      write: { allow: prev.write.allow.filter((r) => r.id !== id) }
                  }
                : prev
        );
        const res = await deletePermissionApi(id);
        if (res.code === SUCCESS_CODE) {
            message.success('已删除规则');
        } else {
            refresh();
        }
    };

    return (
        <Spin spinning={loading} className={cx('remembered-rules', styles.toString())}>
            <div className="remembered-rules-row">
                <div>
                    <div className="remembered-rules-title">自动放行</div>
                    <div className="remembered-rules-hint">
                        开启后，命中「已记住」命令头的 Bash
                        命令将自动执行、不再弹确认；关闭则所有命令都需确认（不删除规则）。
                    </div>
                </div>
                <Switch checked={enabled} onChange={handleToggle} />
            </div>

            <div className="remembered-rules-list-header">
                已记住的命令（{bashRules.length}）
                <span className="remembered-rules-hint">
                    匹配按命令头前缀；含 && / | / 重定向的复合命令与高危命令（rm / sudo 等）不会被记住。
                </span>
            </div>

            {bashRules.length === 0 ? (
                <Empty description="暂无已记住的命令" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
                <div className="remembered-rules-list">
                    {bashRules.map((rule) => (
                        <div key={rule.id} className="remembered-rules-item">
                            <div className="remembered-rules-item-main">
                                <code className="remembered-rules-item-head">{rule.head}</code>
                                <Tag className="remembered-rules-item-tag">命令头前缀</Tag>
                            </div>
                            <div className="remembered-rules-item-meta">
                                <span className="remembered-rules-item-time">
                                    {dayjs(rule.createdAt).format('YYYY-MM-DD HH:mm:ss')}
                                </span>
                                <Popconfirm
                                    title="删除此规则？"
                                    description="删除后该命令将恢复每次确认"
                                    onConfirm={() => handleDelete(rule.id)}
                                    okText="删除"
                                    cancelText="取消"
                                    okButtonProps={{ danger: true }}
                                >
                                    <Button type="text" size="small" danger icon={<DeleteOutlined />}>
                                        删除
                                    </Button>
                                </Popconfirm>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="remembered-rules-list-header">
                已记住的写入目录（{writeRules.length}）
                <span className="remembered-rules-hint">
                    写入目标落在该目录或其子目录内时免确认；系统目录与应用配置目录不会被记住。
                </span>
            </div>

            {writeRules.length === 0 ? (
                <Empty description="暂无已记住的写入目录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
                <div className="remembered-rules-list">
                    {writeRules.map((rule) => (
                        <div key={rule.id} className="remembered-rules-item">
                            <div className="remembered-rules-item-main">
                                <code className="remembered-rules-item-head">{rule.dir}</code>
                                <Tag className="remembered-rules-item-tag">目录前缀</Tag>
                            </div>
                            <div className="remembered-rules-item-meta">
                                <span className="remembered-rules-item-time">
                                    {dayjs(rule.createdAt).format('YYYY-MM-DD HH:mm:ss')}
                                </span>
                                <Popconfirm
                                    title="删除此规则？"
                                    description="删除后写入该目录将恢复每次确认"
                                    onConfirm={() => handleDelete(rule.id)}
                                    okText="删除"
                                    cancelText="取消"
                                    okButtonProps={{ danger: true }}
                                >
                                    <Button type="text" size="small" danger icon={<DeleteOutlined />}>
                                        删除
                                    </Button>
                                </Popconfirm>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </Spin>
    );
}

export default RememberedRules;
