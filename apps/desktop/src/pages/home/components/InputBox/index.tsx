import { CloseOutlined, FileTextOutlined, LoadingOutlined, PaperClipOutlined } from '@ant-design/icons';
import { Sender, Suggestion, type SuggestionProps } from '@ant-design/x';
import { useRequest } from 'ahooks';
import { App, Button, Tooltip, Upload } from 'antd';
import { useState, type ClipboardEvent, type DragEvent } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import { useDangerMode } from '@/hooks';
import { fetchCommandsApi, resolveAttachmentUrl, uploadChatFileApi, type UploadedAttachment } from '@/services';
import { useChatStore } from '@/stores';
import { compressImage } from '@/utils/image';

import { TokenUsageIndicator } from '../TokenUsageIndicator';

import { ApprovalModePicker } from './ApprovalModePicker';
import useStyles from './styles';

interface InputBoxProps {
    onSend: (message: string, attachments?: UploadedAttachment[]) => void;
    /** 流式进行中点击停止按钮时触发 */
    onStop?: () => void;
    disabled?: boolean;
    loading?: boolean;
    /** 有待确认的审批/提问：拦住发送但不禁止输入，避免丢掉用户已输入的内容 */
    blocked?: boolean;
}

/** 输入框内待发送附件（上传中 / 成功 / 失败三态）。 */
interface PendingAttachment {
    uid: string;
    filename: string;
    mediaType: string;
    size: number;
    status: 'uploading' | 'done' | 'error';
    ref?: UploadedAttachment;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 原生多模态图片类型（受模型 image 能力门控） */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** 服务端提取为文本的文档类（恒可传） */
const DOC_EXTS = ['.csv', '.xlsx', '.docx'];
/** 纯文本 / 代码类（按扩展名判定，与后端 extract.ts 的 TEXT_LIKE_RE 对齐；恒可传） */
const TEXT_EXTS = [
    '.txt',
    '.md',
    '.markdown',
    '.log',
    '.json',
    '.jsonc',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.conf',
    '.xml',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.c',
    '.h',
    '.cc',
    '.cpp',
    '.hpp',
    '.cs',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.kts',
    '.rb',
    '.php',
    '.py',
    '.pyi',
    '.sh',
    '.bash',
    '.zsh',
    '.sql',
    '.js',
    '.mjs',
    '.cjs',
    '.jsx',
    '.ts',
    '.tsx',
    '.vue',
    '.svelte',
    '.env',
    '.properties',
    '.gradle'
];

/** 取小写扩展名（含点），无扩展名返回空串 */
function extOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function InputBox({ onSend, onStop, disabled, loading, blocked }: InputBoxProps) {
    const { styles, cx } = useStyles();
    const { message } = App.useApp();
    // Sender 是非受控组件时，发送后不会自动清空文本框；显式接管 value，发送成功后手动清空
    const [value, setValue] = useState('');
    const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
    // 拖拽文件悬停高亮
    const [dragOver, setDragOver] = useState(false);
    // 后端以 --dangerously-skip-permissions 启动时，所有命令免确认直接执行——常驻红色 Tag 提示用户
    const dangerMode = useDangerMode();
    const currentConversationId = useChatStore((s) => s.currentConversationId);

    // slash 命令联想：内置 + 用户命令，窗口重新聚焦时刷新（设置页新建的命令回来即可用）
    const { data: commands } = useRequest(
        async () => {
            const res = await fetchCommandsApi();
            return res.code === SUCCESS_CODE && res.data ? [...res.data.builtin, ...res.data.user] : [];
        },
        { refreshOnWindowFocus: true, cacheKey: 'slash-commands' }
    );
    const commandItems = (query?: string): Extract<SuggestionProps['items'], unknown[]> =>
        (commands ?? [])
            .filter((c) => !query || c.name.startsWith(query))
            .map((c) => ({
                value: c.name,
                label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
                extra: c.description
            }));

    // 全类型放开：图片/PDF 一律允许上传，模型不支持则由后端 provider 报错经会话区如实回显；
    // 文档类（CSV/Excel/Word）与纯文本·代码由后端提取为文本注入，同样不受模型能力限制
    const acceptTypes = [...IMAGE_MIMES, 'application/pdf', ...DOC_EXTS, ...TEXT_EXTS];
    // 只要会话就绪即启用附件按钮
    const attachEnabled = !!currentConversationId;
    const uploading = attachments.some((a) => a.status === 'uploading');

    /** 拖拽/粘贴进来的文件无 accept 过滤，这里按与 accept 一致的规则判一次，避免无谓上传 */
    const isAcceptedFile = (file: File): boolean => {
        const ext = extOf(file.name);
        if (file.type.startsWith('image/')) return IMAGE_MIMES.includes(file.type);
        if (file.type === 'application/pdf' || ext === '.pdf') return true;
        return DOC_EXTS.includes(ext) || TEXT_EXTS.includes(ext);
    };

    const removeAttachment = (uid: string) => setAttachments((prev) => prev.filter((a) => a.uid !== uid));

    const handleSelect = (file: File) => {
        const sid = currentConversationId;
        if (!sid) {
            message.error('会话未就绪，无法上传附件');
            return;
        }
        if (!isAcceptedFile(file)) {
            message.error(`不支持的文件类型：${file.name}`);
            return;
        }
        void (async () => {
            let f = file;
            // 图片上传前在本地降采样 + 重编码，减小上传与 base64 注入体积（失败回退原图）
            if (f.type.startsWith('image/')) {
                try {
                    f = await compressImage(f);
                } catch {
                    f = file;
                }
            }
            const limit = f.type.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
            if (f.size > limit) {
                message.error(`「${f.name}」过大（上限 ${Math.floor(limit / 1024 / 1024)}MB）`);
                return;
            }
            const uid = crypto.randomUUID();
            setAttachments((prev) => [
                ...prev,
                { uid, filename: f.name, mediaType: f.type, size: f.size, status: 'uploading' }
            ]);
            // 上传失败的 toast 由 request 拦截器统一处理，这里只更新卡片态
            const res = await uploadChatFileApi(f, sid);
            setAttachments((prev) =>
                prev.map((a) =>
                    a.uid === uid
                        ? res.code === SUCCESS_CODE && res.data
                            ? { ...a, status: 'done', ref: res.data }
                            : { ...a, status: 'error' }
                        : a
                )
            );
        })();
    };

    // 粘贴：仅处理剪贴板中的文件（截图/图片等）；纯文本粘贴走默认行为
    const handlePaste = (e: ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        files.forEach((f) => handleSelect(f));
    };

    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        Array.from(e.dataTransfer?.files ?? []).forEach((f) => handleSelect(f));
    };

    const handleDragOver = (e: DragEvent) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
        if (!dragOver) setDragOver(true);
    };

    const handleDragLeave = (e: DragEvent) => {
        // 仅在离开整个容器时取消高亮，忽略子元素间冒泡
        if (e.currentTarget === e.target) setDragOver(false);
    };

    const handleSubmit = (text: string) => {
        const trimmed = text.trim();
        if (blocked) {
            message.warning('请先处理输入框上方的待确认操作');
            return;
        }
        if (uploading) {
            message.warning('附件上传中，请稍候');
            return;
        }
        const refs = attachments.filter((a) => a.status === 'done' && a.ref).map((a) => a.ref as UploadedAttachment);
        if (!trimmed && refs.length === 0) return;
        onSend(trimmed, refs);
        setValue('');
        setAttachments([]);
    };

    const attachButton = (
        <Upload
            multiple
            showUploadList={false}
            accept={acceptTypes.join(',')}
            disabled={!attachEnabled}
            beforeUpload={(file) => {
                handleSelect(file as unknown as File);
                return false;
            }}
        >
            <Tooltip
                title={attachEnabled ? '添加图片 / PDF / 表格 / Word / 文本·代码（支持拖拽、粘贴）' : '会话未就绪'}
            >
                <Button
                    className="input-box-attach-button"
                    type="text"
                    aria-label="添加附件"
                    icon={<PaperClipOutlined />}
                    disabled={!attachEnabled}
                />
            </Tooltip>
        </Upload>
    );

    return (
        <div
            className={cx('input-box', dragOver && 'is-dragover', styles.toString())}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
        >
            {attachments.length > 0 && (
                <div className="input-box-attachments">
                    {attachments.map((a) => (
                        <div key={a.uid} className={cx('input-box-attachment', `is-${a.status}`)}>
                            {a.status === 'uploading' ? (
                                <LoadingOutlined className="input-box-attachment-icon" />
                            ) : a.mediaType.startsWith('image/') && a.ref ? (
                                <img
                                    className="input-box-attachment-thumb"
                                    src={resolveAttachmentUrl(a.ref.url)}
                                    alt={a.filename}
                                />
                            ) : (
                                <FileTextOutlined className="input-box-attachment-icon" />
                            )}
                            <span className="input-box-attachment-name" title={a.filename}>
                                {a.status === 'error' ? `${a.filename}（上传失败）` : a.filename}
                            </span>
                            <CloseOutlined
                                className="input-box-attachment-remove"
                                onClick={() => removeAttachment(a.uid)}
                            />
                        </div>
                    ))}
                </div>
            )}
            <Suggestion<string> block items={(query) => commandItems(query)} onSelect={(name) => setValue(`/${name} `)}>
                {({ onTrigger, onKeyDown, open }) => (
                    <Sender
                        classNames={{
                            root: 'input-box-composer',
                            content: 'input-box-editor',
                            footer: 'input-box-footer'
                        }}
                        placeholder={blocked ? '处理待确认操作后可以继续发送' : '输入问题或描述任务…'}
                        value={value}
                        onChange={(next) => {
                            // 仅在输入命令名阶段（`/` 开头、尚无空白）弹出联想
                            const match = /^\/([a-z0-9-]*)$/.exec(next);
                            if (match && commandItems(match[1]).length > 0) onTrigger(match[1]);
                            else onTrigger(false);
                            setValue(next);
                        }}
                        onKeyDown={(e) => {
                            // Suggestion 把输入框包在 Cascader 里，其根节点（rc-select BaseSelect）的 onKeyDown
                            // 会对非可搜索模式的 Space / Enter 调 preventDefault（ARIA「空格开下拉」），
                            // 导致输入框打不出空格、Shift+Enter 无法换行。联想未打开时 Cascader 无需任何按键，
                            // 一律截断冒泡；打开时仍放行方向键 / Enter（选中联想项靠它），只截断空格与 Shift+Enter。
                            if (!open || e.key === ' ' || (e.key === 'Enter' && e.shiftKey)) e.stopPropagation();
                            return onKeyDown(e);
                        }}
                        disabled={disabled}
                        loading={loading}
                        submitType="enter"
                        suffix={false}
                        footer={(actions) => (
                            <div className="input-box-toolbar">
                                <div className="input-box-toolbar-leading">
                                    {attachButton}
                                    <ApprovalModePicker
                                        disabled={disabled || loading || blocked}
                                        dangerMode={dangerMode}
                                    />
                                    <span className="input-box-shortcuts">Shift + Enter 换行 · / 命令</span>
                                </div>
                                <div className="input-box-primary-actions">{actions}</div>
                            </div>
                        )}
                        onSubmit={handleSubmit}
                        onCancel={onStop}
                        autoSize={{ minRows: 1, maxRows: 5 }}
                    />
                )}
            </Suggestion>
            <div className="input-box-hint">
                <span className="input-box-hint-usage">
                    <TokenUsageIndicator />
                </span>
            </div>
        </div>
    );
}
