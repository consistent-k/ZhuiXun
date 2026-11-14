import type { useAppProps } from 'antd/es/app/context';

/**
 * 模块级持有 antd 的 message / modal 实例，供**非组件模块**（如 request 拦截器）调用。
 * antd v6 的静态 `message.xxx` / `Modal.xxx` 不消费 ConfigProvider（拿不到自定义主题与
 * prefixCls="zhuixun"），故统一改走 App.useApp() 的实例。由挂在 <App/> 内的
 * <AntdStaticBridge/>（见 theme/index.tsx）写入这里，组件内则直接用 App.useApp()。
 */
export const staticApi: { message?: useAppProps['message']; modal?: useAppProps['modal'] } = {};
