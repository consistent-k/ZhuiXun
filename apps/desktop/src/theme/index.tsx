import { App } from 'antd';
import { ThemeProvider } from 'antd-style';
import { useEffect, useLayoutEffect, type PropsWithChildren } from 'react';

import { useSettingsStore } from '@/stores';
import { staticApi } from '@/utils/antdStatic';

import { applyThemeVars } from './cssVars';
import { getTheme } from './themes';

/**
 * 挂在 <App/> 上下文内，把 message / modal 实例暴露给模块级 staticApi，
 * 供非组件模块（如 request 拦截器）调用。渲染 null。
 */
const AntdStaticBridge = () => {
    const app = App.useApp();
    useEffect(() => {
        staticApi.message = app.message;
        staticApi.modal = app.modal;
    }, [app]);
    return null;
};

/**
 * 全局主题 Provider：订阅前端主题偏好，按注册表取当前主题，驱动两条换肤链路——
 * antd token（ThemeProvider）与 CSS 变量层（applyThemeVars，经布局副作用在绘制前写入）。
 */
const BaseThemeProvider = ({ children }: PropsWithChildren) => {
    const themeId = useSettingsStore((s) => s.theme);
    const theme = getTheme(themeId);

    // 布局副作用：在首帧绘制前写入 CSS 变量，避免主题切换/首屏的闪色
    useLayoutEffect(() => {
        applyThemeVars(theme);
    }, [theme]);

    return (
        <ThemeProvider prefixCls="zhuixun" theme={theme.config}>
            <App
                component={false}
                message={{
                    top: 90,
                    duration: 3,
                    maxCount: 1
                }}
            >
                <AntdStaticBridge />
                {children}
            </App>
        </ThemeProvider>
    );
};

export default BaseThemeProvider;
