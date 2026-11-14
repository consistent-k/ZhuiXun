import { Modal as AntdModal } from 'antd';
import type { ModalProps } from 'antd';

import { colors, rounded, spacing } from '@/theme/tokens';

import useStyles from './styles';

/** 全局统一弹窗标准宽度 */
export const MODAL_WIDTH = 640;

export type { ModalProps };

/**
 * 全局统一 Modal 组件。
 *
 * 统一约定：默认 width=640、居中、隐藏时销毁内容、body 超高时滚动、中文「保存 / 取消」文案。
 * 以上默认值均可被显式传入的同名 props 覆盖（如 width、okText、centered）。
 *
 * 表单类弹窗统一采用「<Modal> + <Form>」声明式写法，不再使用命令式 modal.confirm()。
 */
export function Modal({ okText = '保存', cancelText = '取消', styles, className, children, ...rest }: ModalProps) {
    const { styles: dialogStyles, cx } = useStyles();

    return (
        <AntdModal
            className={cx(dialogStyles.toString(), className)}
            width={MODAL_WIDTH}
            centered
            destroyOnHidden
            okText={okText}
            cancelText={cancelText}
            // 容器限高，滚动只发生在正文，长表单仍可直接保存或取消。
            styles={(info) => {
                const overrides = typeof styles === 'function' ? styles(info) : styles;
                return {
                    ...overrides,
                    container: {
                        display: 'flex',
                        flexDirection: 'column',
                        maxHeight: 'calc(100dvh - 48px)',
                        padding: 0,
                        borderRadius: rounded.xl,
                        ...overrides?.container
                    },
                    header: {
                        flexShrink: 0,
                        margin: 0,
                        padding: '16px 52px 12px 24px',
                        borderRadius: `${rounded.xl}px ${rounded.xl}px 0 0`,
                        borderBottom: `1px solid ${colors.hairline}`,
                        ...overrides?.header
                    },
                    body: {
                        minHeight: 0,
                        overflowY: 'auto',
                        padding: `${spacing.md}px ${spacing.lg}px`,
                        ...overrides?.body
                    },
                    footer: {
                        flexShrink: 0,
                        margin: 0,
                        padding: `${spacing.sm}px ${spacing.lg}px`,
                        borderTop: `1px solid ${colors.hairline}`,
                        ...overrides?.footer
                    },
                    close: { top: 12, insetInlineEnd: 12, ...overrides?.close }
                };
            }}
            {...rest}
        >
            {children}
        </AntdModal>
    );
}

export default Modal;
