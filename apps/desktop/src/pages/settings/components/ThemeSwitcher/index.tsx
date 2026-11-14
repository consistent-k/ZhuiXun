import { CheckCircleFilled } from '@ant-design/icons';

import { useSettings } from '@/hooks';

import useStyles from './styles';

/**
 * 主题选择器：以预览色样卡片网格展示全部已注册主题，点击即切换（纯前端持久化）。
 * 当前主题高亮并显示勾选标记。
 */
export function ThemeSwitcher() {
    const { cx, styles } = useStyles();
    const { theme, setTheme, themeList } = useSettings();

    return (
        <div className={cx('theme-switcher', styles.toString())}>
            {themeList.map((item) => {
                const active = item.id === theme;
                return (
                    <div
                        key={`theme-card-${item.id}`}
                        className={cx('theme-switcher-card', active && 'is-active')}
                        role="button"
                        aria-pressed={active}
                        onClick={() => setTheme(item.id)}
                    >
                        <div className="theme-switcher-preview">
                            <span className="theme-switcher-swatch" style={{ background: item.preview.background }} />
                            <span className="theme-switcher-swatch" style={{ background: item.preview.accent }} />
                            <span className="theme-switcher-swatch" style={{ background: item.preview.primary }} />
                        </div>
                        <div className="theme-switcher-meta">
                            <span className="theme-switcher-name">{item.name}</span>
                            {active && <CheckCircleFilled className="theme-switcher-check" />}
                        </div>
                        <div className="theme-switcher-desc">{item.description}</div>
                    </div>
                );
            })}
        </div>
    );
}

export default ThemeSwitcher;
