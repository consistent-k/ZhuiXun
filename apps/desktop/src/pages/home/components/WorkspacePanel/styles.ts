import createStyles from '@/utils/createStyles';

export default createStyles(({ css, token, prefixCls }) =>
    css({
        '&.chat-workspace': {
            position: 'relative',
            display: 'flex',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            '&.chat-workspace-preview-open': {
                overflowX: 'auto',
                '& > .chat-workspace-chat': { minWidth: 320 }
            },
            '& .chat-workspace-chat': { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 },
            // 阈值降低后显式留出卡片空间，避免摘要覆盖消息与输入框。
            '&.chat-workspace-summary-visible .chat-area-workspace': { marginRight: 348 },
            '&.chat-workspace-summary-visible:has(.approval-dock--question) .chat-area-workspace': { marginRight: 0 },
            '& .workspace-summary-float': {
                position: 'absolute',
                top: 76,
                right: 20,
                width: 320,
                maxHeight: 'calc(100% - 100px)',
                display: 'flex',
                overflow: 'hidden',
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 20,
                background: token.colorBgContainer,
                boxShadow: token.boxShadowSecondary
            },
            // 宽屏提问面板会占据右侧留白，此时不叠加摘要卡片。
            '&:has(.approval-dock--question) .workspace-summary-float': { display: 'none' },
            '& .workspace-panel': {
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                flexShrink: 0,
                minHeight: 0,
                background: token.colorBgContainer
            },
            '& .workspace-divider': {
                width: 5,
                cursor: 'col-resize',
                flexShrink: 0,
                background: token.colorBorderSecondary,
                '&:hover, &:focus-visible': { background: token.colorPrimary }
            },
            '& .workspace-close': { position: 'absolute', right: 0, top: 2, zIndex: 1 },
            [`& .${prefixCls}-tabs`]: { flex: '0 0 auto', paddingRight: 28 },
            [`& .${prefixCls}-tabs-nav`]: { marginBottom: 0 },
            '& .workspace-active-content': { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
            '& .workspace-summary': {
                overflow: 'auto',
                padding: 20,
                flex: 1,
                '& section': {
                    paddingTop: 20,
                    paddingBottom: 16,
                    borderBottom: `1px solid ${token.colorBorderSecondary}`
                },
                '& h3': { fontSize: 13, fontWeight: 600, margin: '0 0 12px' },
                '& small': { color: token.colorTextSecondary, marginLeft: 8, fontWeight: 400 },
                '& ul': { padding: 0, listStyle: 'none', margin: 0 },
                '& li': { marginBottom: 10, fontSize: 13, overflowWrap: 'anywhere' }
            },
            '& .workspace-summary-top': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                color: token.colorTextSecondary,
                fontSize: 12
            },
            '& .workspace-task-completed': { color: token.colorTextSecondary },
            '& .workspace-task-in_progress': { color: token.colorPrimary },
            '& .workspace-muted, & .workspace-empty': { color: token.colorTextSecondary, fontSize: 13 },
            '& .workspace-empty': { padding: 24 },
            '& .workspace-file-preview': { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 },
            '& .workspace-preview-actions': {
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                padding: '10px 12px',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                '& > span:first-child': {
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12
                }
            },
            '& .workspace-preview-content': {
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                padding: 12,
                overflowWrap: 'anywhere'
            },
            '& .workspace-code': {
                fontSize: 12,
                lineHeight: '22px',
                margin: 0,
                whiteSpace: 'pre',
                fontFamily: token.fontFamilyCode
            },
            '& .workspace-line-number': {
                display: 'inline-block',
                width: 48,
                color: token.colorTextQuaternary,
                userSelect: 'none',
                textAlign: 'right',
                paddingRight: 12
            },
            '& .workspace-code-selected': { background: token.colorPrimaryBg },
            '& .workspace-pdf canvas': { display: 'block', margin: '12px auto', maxWidth: '100%' },
            '& .workspace-image img': { display: 'block', objectFit: 'contain' }
        }
    })
);
