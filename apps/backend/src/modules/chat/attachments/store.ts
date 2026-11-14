import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { paths } from '@/config/paths';
import { isValidConversationId } from '@/modules/conversations';
import { createLogger } from '@/platform/logging/index';

import { isTextLike } from './extract';

const log = createLogger('Attachments');

/**
 * 对话附件白名单：图片与 PDF 走原生多模态；CSV / Excel(.xlsx) / Word(.docx) / 纯文本·代码
 * 由服务端提取为文本/Markdown 注入（见 attachments/extract.ts），不依赖模型多模态能力。
 */
export const ALLOWED_ATTACHMENT_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    // 可提取为文本的文档类型
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel', // 部分浏览器给 .csv 标的 MIME（旧版 .xls 另行按扩展名拒绝）
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown'
] as const;

/**
 * 是否允许上传该附件。MIME 命中白名单即可；此外放行「纯文本·代码」类文件——
 * 这类文件的 MIME 极不可靠（浏览器常给空串或 video/mp2t），只能按扩展名判定。
 */
export function isAllowedAttachment(mediaType: string, filename: string): boolean {
    if ((ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(mediaType)) return true;
    return isTextLike(filename, mediaType);
}

/** 单文件上限：图片 10MB，其它（PDF / 表格 / Word / 文本·代码）20MB。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 上传成功后返回给前端的引用信息。 */
export interface UploadedAttachment {
    id: string;
    filename: string;
    mediaType: string;
    size: number;
    /** 后端引用路径 `/api/chat/files/<sid>/<id>`；前端拼 API_BASE_URL 作为 FileUIPart.url。 */
    url: string;
}

interface AttachmentMeta {
    filename: string;
    mediaType: string;
    size: number;
    createdAt: number;
}

/** 附件 id 只允许安全字符（会拼进文件名，杜绝路径穿越）。 */
function isValidAttachmentId(id: string): boolean {
    return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function metaPath(dir: string, id: string): string {
    return path.join(dir, `${id}.meta.json`);
}

/** 该会话是否允许写附件：会话 id 合法即可（草稿会话也允许，落在其 uploads 子目录）。 */
export function canStoreAttachment(sessionId: string): boolean {
    return isValidConversationId(sessionId);
}

/**
 * 保存单个对话附件到 <sessionsDir>/<sid>/uploads/。
 * 字节落 `<id>`，元信息落 `<id>.meta.json`（保留原始文件名与 mediaType）。
 *
 * @param sessionId 会话 id（草稿会话亦可）
 * @param input     文件字节与元信息
 * @returns 引用信息（含 `/api/chat/files/<sid>/<id>` 路径）
 */
export async function saveAttachment(
    sessionId: string,
    input: { data: Uint8Array; filename: string; mediaType: string }
): Promise<UploadedAttachment> {
    if (!canStoreAttachment(sessionId)) throw new Error('非法会话 id');
    const dir = paths.sessionUploadsDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const id = randomUUID();
    const meta: AttachmentMeta = {
        filename: input.filename,
        mediaType: input.mediaType,
        size: input.data.byteLength,
        createdAt: Date.now()
    };
    await fs.writeFile(path.join(dir, id), input.data);
    await fs.writeFile(metaPath(dir, id), JSON.stringify(meta), 'utf8');
    return {
        id,
        filename: meta.filename,
        mediaType: meta.mediaType,
        size: meta.size,
        url: `/api/chat/files/${sessionId}/${id}`
    };
}

/**
 * 读取附件字节与元信息；不存在或 id 非法返回 null。
 *
 * @param sessionId 会话 id
 * @param id        附件 id
 */
export async function readAttachment(
    sessionId: string,
    id: string
): Promise<{ data: Uint8Array; meta: AttachmentMeta } | null> {
    if (!isValidConversationId(sessionId) || !isValidAttachmentId(id)) return null;
    const dir = paths.sessionUploadsDir(sessionId);
    try {
        const data = await fs.readFile(path.join(dir, id));
        let meta: AttachmentMeta;
        try {
            meta = JSON.parse(await fs.readFile(metaPath(dir, id), 'utf8')) as AttachmentMeta;
        } catch {
            // 元信息缺失时按 octet-stream 兜底（正常流程都会有 meta）
            meta = { filename: id, mediaType: 'application/octet-stream', size: data.byteLength, createdAt: 0 };
        }
        return { data: new Uint8Array(data), meta };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn('读取附件失败', { sessionId, id, err });
        }
        return null;
    }
}

/** 删除整个会话的附件目录（会话删除时清理）；幂等，失败只告警。 */
export async function removeSessionAttachments(sessionId: string): Promise<void> {
    if (!isValidConversationId(sessionId)) return;
    try {
        await fs.rm(path.join(paths.sessionsDir(), sessionId), { recursive: true, force: true });
    } catch (err) {
        log.warn('清理会话附件目录失败（忽略）', { sessionId, err });
    }
}

/** 从 FileUIPart.url 解析出 `{ sid, id }`（匹配 `/api/chat/files/<sid>/<id>`），不匹配返回 null。 */
export function parseAttachmentRef(url: string): { sid: string; id: string } | null {
    const m = /\/api\/chat\/files\/([^/?#]+)\/([^/?#]+)/.exec(url);
    if (!m) return null;
    return { sid: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) };
}
