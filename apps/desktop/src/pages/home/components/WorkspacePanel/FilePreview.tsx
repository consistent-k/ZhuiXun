import type { WorkspaceFileView } from '@zhuixun/shared';
import { Alert, App, Button } from 'antd';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { SUCCESS_CODE } from '@/constant/code';
import {
    approveWorkspaceFileApi,
    downloadWorkspaceFileApi,
    readWorkspaceFileApi,
    resolveWorkspaceFileApi
} from '@/services/workspace';
import { useWorkspacePanelStore, type FileTab } from '@/stores/workspacePanelStore';
import { API_BASE_URL } from '@/utils/request';

import { StreamingMarkdown } from '../StreamingMarkdown';

import { FileTurnContext } from './file-reference';
import { readingPosition, rememberPosition } from './reading-state';

const PdfPreview = lazy(() => import('./PdfPreview'));

/** 单个活动文件的独立加载周期，卸载即取消；正文不进入全局持久状态。 */
export function FilePreview({ id, tab, changed }: { id: string; tab: FileTab; changed: string }) {
    const { modal, message } = App.useApp();
    const [view, setView] = useState<WorkspaceFileView>();
    const [blob, setBlob] = useState<Blob>();
    const [text, setText] = useState('');
    const image = useRef<HTMLImageElement>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [readVersion, setReadVersion] = useState(changed);
    const content = useRef<HTMLDivElement>(null);
    const positionKey = `${useWorkspacePanelStore.getState().instance}:${id}:${tab.id}`;
    useEffect(() => {
        if (!blob || !content.current) return;
        const element = content.current;
        element.scrollTop = readingPosition(positionKey).scroll ?? 0;
        const save = () => rememberPosition(positionKey, { scroll: element.scrollTop });
        element.addEventListener('scroll', save, { passive: true });
        return () => element.removeEventListener('scroll', save);
    }, [blob, positionKey]);
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        let confirmation: { destroy: () => void } | undefined;
        const load = async () => {
            setLoading(true);
            setError('');
            setBlob(undefined);
            setText('');
            setView(undefined);
            try {
                const result = await resolveWorkspaceFileApi(id, tab.reference);
                if (cancelled) return;
                if (result.code !== SUCCESS_CODE || !result.data) throw new Error(result.message ?? '文件解析失败');
                const file = result.data;
                setView(file);
                if (file.tooLarge || file.preview === 'unsupported') return;
                if (file.approvalRequired) {
                    const approved = await new Promise<boolean>((resolve) => {
                        confirmation = modal.confirm({
                            title: '确认读取文件',
                            content: `读取权限要求确认：${file.name}`,
                            okText: '允许本次读取',
                            cancelText: '取消',
                            onOk: () => resolve(true),
                            onCancel: () => resolve(false),
                            afterClose: () => resolve(false)
                        });
                    });
                    if (cancelled) return;
                    if (!approved) throw new Error('已取消读取，可点击刷新重试');
                    const grant = await approveWorkspaceFileApi(id, file.fileId);
                    if (grant.code !== SUCCESS_CODE) throw new Error(grant.message ?? '确认已失效');
                }
                const body = await readWorkspaceFileApi(id, file.fileId, controller.signal);
                const plain = file.preview === 'text' || file.preview === 'markdown' ? await body.text() : '';
                if (!cancelled) {
                    setBlob(body);
                    setText(plain);
                    setReadVersion(changed);
                }
            } catch (reason) {
                if (!cancelled) setError(reason instanceof Error ? reason.message : '预览失败');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        return () => {
            cancelled = true;
            controller.abort();
            confirmation?.destroy();
        };
        // 文件变化只提示，不自动替换用户正在阅读的正文。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, tab.id, refresh]);
    useEffect(() => {
        if (!blob || view?.preview !== 'image') return;
        const objectUrl = URL.createObjectURL(blob);
        if (image.current) image.current.src = objectUrl;
        return () => URL.revokeObjectURL(objectUrl);
    }, [blob, view?.preview]);
    useEffect(() => {
        if (!text || !tab.line) return;
        content.current?.querySelector(`[data-line="${tab.line}"]`)?.scrollIntoView({ block: 'center' });
    }, [text, tab.line]);
    const download = async () => {
        try {
            const resolved = await resolveWorkspaceFileApi(id, tab.reference);
            if (resolved.code !== SUCCESS_CODE || !resolved.data) throw new Error(resolved.message ?? '文件解析失败');
            const file = resolved.data;
            if (file.approvalRequired) {
                const allowed = await new Promise<boolean>((resolve) =>
                    modal.confirm({
                        title: '确认下载文件',
                        content: file.name,
                        onOk: () => resolve(true),
                        onCancel: () => resolve(false),
                        afterClose: () => resolve(false)
                    })
                );
                if (!allowed) return;
                const approved = await approveWorkspaceFileApi(id, file.fileId);
                if (approved.code !== SUCCESS_CODE) throw new Error(approved.message ?? '确认失败');
            }
            const result = await downloadWorkspaceFileApi(id, file.fileId);
            if (result.code !== SUCCESS_CODE || !result.data) throw new Error(result.message ?? '下载失败');
            const anchor = document.createElement('a');
            anchor.href = `${API_BASE_URL}${result.data.url}`;
            anchor.download = file.name;
            anchor.referrerPolicy = 'no-referrer';
            anchor.click();
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : '下载失败');
        }
    };
    return (
        <div className="workspace-file-preview">
            <div className="workspace-preview-actions">
                <span title={tab.reference.kind === 'workspace' ? tab.reference.path : view?.name}>
                    {view?.name ?? tab.reference.name}
                </span>
                <Button size="small" onClick={() => setRefresh((value) => value + 1)}>
                    刷新
                </Button>
                {view && (
                    <Button size="small" onClick={() => void download()}>
                        下载
                    </Button>
                )}
                {text && (
                    <Button
                        size="small"
                        onClick={() =>
                            void navigator.clipboard
                                .writeText(text)
                                .then(() => message.success('已复制'))
                                .catch(() => message.error('复制失败'))
                        }
                    >
                        复制
                    </Button>
                )}
            </div>
            {changed !== readVersion && <Alert type="info" title="文件已更新，请刷新预览" />}
            {error && <Alert type="error" title="无法预览文件" description={error} />}
            {loading && <p role="status">正在加载预览…</p>}
            {view?.tooLarge && (
                <Alert
                    type="warning"
                    title="文件超过预览大小限制"
                    description={`文件 ${(view.size / 1024 ** 2).toFixed(2)} MiB，上限 ${view.limit / 1024 ** 2} MiB`}
                />
            )}
            {view?.preview === 'unsupported' && <Alert type="info" title="暂不支持该文件类型的富预览" />}
            <div className="workspace-preview-content" ref={content}>
                {blob && view?.preview === 'markdown' && (
                    <FileTurnContext.Provider value={tab.reference.turnId}>
                        <StreamingMarkdown text={text} safeFile />
                    </FileTurnContext.Provider>
                )}
                {blob && view?.preview === 'text' && (
                    <pre className="workspace-code">
                        {text.split('\n').map((line, index) => (
                            <div
                                key={`line-${index}`}
                                data-line={index + 1}
                                className={tab.line === index + 1 ? 'workspace-code-selected' : undefined}
                            >
                                <span className="workspace-line-number">{index + 1}</span>
                                {line || ' '}
                            </div>
                        ))}
                    </pre>
                )}
                {blob && view?.preview === 'image' && (
                    <ImagePreview imageRef={image} name={view.name} positionKey={positionKey} />
                )}
                {blob && view?.preview === 'pdf' && (
                    <Suspense fallback={<p>正在准备 PDF 预览…</p>}>
                        <PdfPreview blob={blob} positionKey={positionKey} />
                    </Suspense>
                )}
            </div>
        </div>
    );
}
function ImagePreview({
    imageRef,
    name,
    positionKey
}: {
    imageRef: React.RefObject<HTMLImageElement | null>;
    name: string;
    positionKey: string;
}) {
    const [scale, setScale] = useState(readingPosition(positionKey).scale ?? 1);
    const [imageError, setImageError] = useState(false);
    const zoom = (next: number) => {
        setScale(next);
        rememberPosition(positionKey, { scale: next });
    };
    return (
        <div className="workspace-image">
            <div className="workspace-preview-actions">
                <Button onClick={() => zoom(Math.max(0.25, scale - 0.25))}>缩小</Button>
                <Button onClick={() => zoom(1)}>适应面板</Button>
                <Button onClick={() => zoom(Math.min(4, scale + 0.25))}>放大</Button>
            </div>
            {imageError && <p role="alert">图片无法解码，请检查文件格式</p>}
            <img
                ref={imageRef}
                alt={name}
                onError={() => setImageError(true)}
                style={{ width: `${scale * 100}%`, maxWidth: 'none' }}
            />
        </div>
    );
}
