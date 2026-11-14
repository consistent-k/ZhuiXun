import { Tabs } from 'antd';

import { PolicyRules } from './components/PolicyRules';
import { RememberedRules } from './components/RememberedRules';
import useStyles from './styles';

/** 命令授权面板：「已记住的授权」（审批卡上点记住产生）与「策略规则」（声明式 deny / ask / allow）。 */
export function PermissionPanel() {
    const { styles, cx } = useStyles();

    return (
        <Tabs
            className={cx('permission-panel', styles.toString())}
            defaultActiveKey="remembered"
            destroyOnHidden
            items={[
                { key: 'remembered', label: '已记住的授权', children: <RememberedRules /> },
                { key: 'policy', label: '策略规则', children: <PolicyRules /> }
            ]}
        />
    );
}

export default PermissionPanel;
