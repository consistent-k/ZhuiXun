import { Button } from 'antd';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';

import { readingPosition, rememberPosition } from './reading-state';

GlobalWorkerOptions.workerSrc = workerUrl;

/** PDF 按页解码，切走时取消任务和释放 worker，不挂载隐藏整本文档。 */
export default function PdfPreview({ blob, positionKey }: { blob: Blob; positionKey: string }) {
    const [document, setDocument] = useState<PDFDocumentProxy>();
    const [page, setPage] = useState(readingPosition(positionKey).page ?? 1);
    const changePage = (next: number) => {
        setPage(next);
        rememberPosition(positionKey, { page: next });
    };
    const [error, setError] = useState('');
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        let cancelled = false;
        let loading: ReturnType<typeof getDocument> | undefined;
        void blob
            .arrayBuffer()
            .then(async (data) => {
                if (cancelled) return;
                loading = getDocument({ data: new Uint8Array(data) });
                const pdf = await loading.promise;
                if (!cancelled) setDocument(pdf);
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : 'PDF 加载失败');
            });
        return () => {
            cancelled = true;
            void loading?.destroy();
        };
    }, [blob]);
    useEffect(() => {
        if (!document || !canvas.current) return;
        let cancelled = false;
        let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
        void document
            .getPage(page)
            .then(async (pdfPage) => {
                if (cancelled || !canvas.current) return;
                const base = pdfPage.getViewport({ scale: 1 });
                const available = canvas.current.parentElement?.clientWidth ?? 380;
                const viewport = pdfPage.getViewport({ scale: Math.min(2, (available - 24) / base.width) });
                canvas.current.width = viewport.width;
                canvas.current.height = viewport.height;
                render = pdfPage.render({ canvas: canvas.current, viewport });
                await render.promise;
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : 'PDF 渲染失败');
            });
        return () => {
            cancelled = true;
            render?.cancel();
        };
    }, [document, page]);
    if (error) return <p role="alert">PDF 预览失败：{error}</p>;
    return (
        <div className="workspace-pdf">
            <div className="workspace-preview-actions">
                <Button disabled={page <= 1} onClick={() => changePage(page - 1)}>
                    上一页
                </Button>
                <span>
                    {page} / {document?.numPages ?? '…'}
                </span>
                <Button disabled={!document || page >= document.numPages} onClick={() => changePage(page + 1)}>
                    下一页
                </Button>
            </div>
            <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />
        </div>
    );
}
