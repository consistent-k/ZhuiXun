import request, { API_BASE_URL, type BaseResponse } from '@/utils/request';

/** 对话附件上传成功后的引用信息（后端 core/attachments/store.ts 返回体）。 */
export interface UploadedAttachment {
    /** 附件 id（会话作用域内唯一）。 */
    id: string;
    /** 原始文件名。 */
    filename: string;
    /** IANA 媒体类型，如 image/png、application/pdf。 */
    mediaType: string;
    /** 字节大小。 */
    size: number;
    /** 后端引用路径 `/api/chat/files/<sid>/<id>`；渲染/发送时拼 API_BASE_URL 得到可访问 URL。 */
    url: string;
}

/**
 * 上传单个对话附件（图片 / PDF），multipart。
 * 显式传 `Content-Type: multipart/form-data`：request 实例默认头是 application/json，
 * 不覆盖的话 axios transformRequest 会把 FormData JSON 序列化（File 变成 {}）导致后端拿不到文件；
 * 传 multipart 头即避开该序列化，boundary 由浏览器自动补上。错误由 request 拦截器统一 toast。
 *
 * @param file      待上传文件
 * @param sessionId 归属会话 id（草稿会话亦可，附件落该会话 uploads 目录）
 * @returns 上传结果（含引用 url）
 */
export function uploadChatFileApi(file: File, sessionId: string): Promise<BaseResponse<UploadedAttachment>> {
    const form = new FormData();
    form.append('file', file);
    form.append('sessionId', sessionId);
    return request.post('/api/chat/upload', { data: form, headers: { 'Content-Type': 'multipart/form-data' } });
}

/** 把附件引用路径拼成可直接访问的绝对 URL（供 FileUIPart.url 与 `<img src>` 使用）。 */
export function resolveAttachmentUrl(url: string): string {
    return url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
}
